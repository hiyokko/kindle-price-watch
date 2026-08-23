import { gzipSync } from 'node:zlib';
import { bootstrapPayload } from './book-list-payload.mjs';
import { getDiscordWebhooks, settingsSummaryFromStore } from './control-service.mjs';
import {
  hasBlobConfig,
  pruneBlobDerivedPayloads,
  registerStoreWriteListener,
  writeBlobBootstrapPayload,
  writeBlobControlPayload
} from './store.mjs';

let registered = false;

export function registerStorePayloadSync() {
  if (registered) return;
  registered = true;

  registerStoreWriteListener(async (store, metadata = {}) => {
    if (!hasBlobConfig() || !metadata.etag) return;

    const [{ publicBooksFromStore }, webhooks] = await Promise.all([
      import('./checker.mjs'),
      getDiscordWebhooks({ store })
    ]);
    const controlPayload = settingsSummaryFromStore(store, webhooks);
    await Promise.all([
      writeBlobBootstrapPayload(
        metadata.etag,
        gzipJson(bootstrapPayload(publicBooksFromStore(store), controlPayload))
      ),
      writeBlobControlPayload(
        metadata.etag,
        gzipJson(controlPayload)
      )
    ]);
    if (shouldPruneDerivedPayloads(store.storeRevision)) {
      await pruneBlobDerivedPayloads();
    }
  });
}

export function shouldPruneDerivedPayloads(storeRevision, options = {}) {
  const revision = Math.max(0, Math.round(Number(storeRevision) || 0));
  const configured = Number(options.interval ?? process.env.BLOB_DERIVED_PAYLOAD_PRUNE_EVERY_WRITES);
  const interval = Number.isFinite(configured)
    ? Math.min(1000, Math.max(1, Math.round(configured)))
    : 8;
  return revision > 0 && revision % interval === 0;
}

function gzipJson(value) {
  return gzipSync(Buffer.from(JSON.stringify(value)));
}
