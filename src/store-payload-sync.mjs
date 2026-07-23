import { gzipSync } from 'node:zlib';
import { bookListPayload } from './book-list-payload.mjs';
import { getDiscordWebhooks, settingsSummaryFromStore } from './control-service.mjs';
import {
  hasBlobConfig,
  pruneBlobDerivedPayloads,
  registerStoreWriteListener,
  writeBlobBookListPayload,
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
    await Promise.all([
      writeBlobBookListPayload(
        metadata.etag,
        gzipJson(bookListPayload(publicBooksFromStore(store)))
      ),
      writeBlobControlPayload(
        metadata.etag,
        gzipJson(settingsSummaryFromStore(store, webhooks))
      )
    ]);
    await pruneBlobDerivedPayloads();
  });
}

function gzipJson(value) {
  return gzipSync(Buffer.from(JSON.stringify(value)));
}
