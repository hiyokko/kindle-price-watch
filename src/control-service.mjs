import { extractAsin } from './amazon-url.mjs';
import {
  getDiscordWebhookUrls,
  sendDiscordNotification
} from './notifier.mjs';
import { readStore, updateStore } from './store.mjs';
import {
  activeWebhookUrls,
  normalizeWebhookEntries,
  parseWebhookUrls
} from './webhook-config.mjs';
import { readWebhookStore, writeWebhookStore } from './webhook-store.mjs';

export async function getSettings() {
  const store = await readStore();
  return mergedRuntimeSettings(store.settings);
}

export async function getAutomationStatus() {
  const store = await readStore();
  return store.automation || {};
}

export async function getSettingsSummary() {
  const [store, webhookStore] = await Promise.all([readStore(), readWebhookStore()]);
  const webhooks = await resolveDiscordWebhooks(webhookStore, store);
  return settingsSummaryFromStore(store, webhooks);
}

export function settingsSummaryFromStore(store = {}, webhooks = {}) {
  return {
    settings: mergedRuntimeSettings(store.settings || {}),
    automation: store.automation || {},
    importQueue: publicBookImportQueue(store.importQueue),
    discordConfigured: Number(webhooks.count || 0) > 0,
    discordWebhookCount: Number(webhooks.count || 0),
    discordWebhookTotalCount: Number(webhooks.totalCount || 0),
    discordWebhookPausedCount: Number(webhooks.pausedCount || 0)
  };
}

export async function getBookImportQueue() {
  const store = await readStore();
  return publicBookImportQueue(store.importQueue);
}

export async function saveBookImportQueue(inputs) {
  const deduped = normalizedUniqueBookInputs(inputs);
  const now = new Date().toISOString();
  let result;

  await updateStore((store) => {
    store.importQueue = store.importQueue || { pending: [], completed: [], errors: [] };
    const previousPending = new Map((store.importQueue.pending || []).map((entry) => [entry.key, entry]));
    store.importQueue.pending = deduped.map((input) => {
      const key = bookImportQueueKey(input);
      const previous = previousPending.get(key);
      return { key, input, addedAt: previous?.addedAt || now };
    });
    result = publicBookImportQueue(store.importQueue);
    return store;
  });

  return result;
}

export async function enqueueBookImportQueue(inputs) {
  const deduped = normalizedUniqueBookInputs(inputs);
  if (deduped.length === 0) {
    const error = new Error('Amazon Kindle URL または ASIN を入力してください');
    error.status = 400;
    throw error;
  }

  const now = new Date().toISOString();
  let result;
  let added = 0;

  await updateStore((store) => {
    store.importQueue = store.importQueue || { pending: [], completed: [], errors: [] };
    const pending = new Map((store.importQueue.pending || []).map((entry) => [entry.key, entry]));
    const completed = new Map((store.importQueue.completed || []).map((entry) => [entry.key, entry]));
    const errors = new Map((store.importQueue.errors || []).map((entry) => [entry.key, entry]));

    for (const input of deduped) {
      const key = bookImportQueueKey(input);
      const previous = pending.get(key);
      if (!previous) added += 1;
      pending.set(key, { key, input, addedAt: previous?.addedAt || now });
      completed.delete(key);
      errors.delete(key);
    }

    store.importQueue.pending = [...pending.values()];
    store.importQueue.completed = [...completed.values()].slice(-200);
    store.importQueue.errors = [...errors.values()].slice(-100);
    result = {
      ...publicBookImportQueue(store.importQueue),
      queued: deduped.length,
      added,
      alreadyPending: Math.max(0, deduped.length - added)
    };
    return store;
  });

  return result;
}

export function publicBookImportQueue(queue = {}) {
  const pending = (queue.pending || []).map((entry) => ({
    key: entry.key,
    input: entry.input,
    addedAt: entry.addedAt || ''
  }));
  const completed = (queue.completed || []).map((entry) => ({
    key: entry.key,
    input: entry.input,
    importedAt: entry.importedAt || '',
    mode: entry.mode || '',
    imported: Number(entry.imported || 0),
    skippedDuplicates: Number(entry.skippedDuplicates || 0),
    updatedDuplicates: Number(entry.updatedDuplicates || 0)
  }));
  const errors = (queue.errors || []).map((entry) => ({
    key: entry.key,
    input: entry.input,
    checkedAt: entry.checkedAt || '',
    error: entry.error || ''
  }));

  return {
    pending,
    completed,
    errors,
    summary: importQueueSummary({ pending, completed, errors })
  };
}

export async function saveSettings(settings) {
  const cleaned = mergedRuntimeSettings({
    ...settings,
    notifyOnPriceDrop: Boolean(settings.notifyOnPriceDrop),
    notifyOnBestEver: Boolean(settings.notifyOnBestEver)
  });

  await updateStore((store) => {
    store.settings = { ...store.settings, ...cleaned };
    return store;
  });
  return cleaned;
}

export function mergedRuntimeSettings(settings = {}) {
  return {
    notificationThreshold: clampNumber(settings.notificationThreshold, 0, 95, 10),
    batchSize: floorNumber(settings.batchSize, 1, 50),
    listPriceChallengeBatchSize: clampNumber(settings.listPriceChallengeBatchSize, 0, 50, 50),
    notifyOnPriceDrop: settings.notifyOnPriceDrop !== false,
    notifyOnBestEver: settings.notifyOnBestEver !== false
  };
}

export async function sendTestNotification() {
  return sendDiscordNotification(
    {
      username: 'Kindle Price Watch',
      content: 'Kindle Price Watch のテスト通知です。'
    },
    { webhookUrls: await getRuntimeDiscordWebhookUrls() }
  );
}

export async function getDiscordWebhooks(options = {}) {
  const webhookStore = await readWebhookStore();
  const store = options.store || (storedDiscordWebhooks(webhookStore) == null ? await readStore() : null);
  return resolveDiscordWebhooks(webhookStore, store);
}

export async function saveDiscordWebhooks(entries) {
  const cleaned = normalizeDiscordWebhookEntries(entries);
  const activeUrls = activeDiscordWebhookUrls(cleaned);
  await writeWebhookStore(cleaned);
  await updateStore((store) => {
    store.settings = {
      ...store.settings,
      discordWebhooks: cleaned,
      discordWebhookUrls: activeUrls
    };
    return store;
  });
  return discordWebhooksPayload(cleaned, {
    usingEnvFallback: false,
    source: 'webhook_store'
  });
}

export async function getDiscordWebhookCount() {
  return (await getDiscordWebhooks()).count;
}

export async function getRuntimeDiscordWebhookUrls() {
  return (await getDiscordWebhooks()).urls;
}

export function parseBookImportInputs(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(normalizeBookImportInput).filter(Boolean);
    } catch {
      // Fall through to line-based parsing.
    }
  }

  return text
    .split(/\r?\n/)
    .map(normalizeBookImportInput)
    .filter((line) => line && !line.startsWith('#'));
}

export function normalizeBookImportInput(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

export function bookImportQueueKey(input) {
  const asin = extractAsin(input);
  return asin ? `asin:${asin}` : `input:${String(input || '').trim()}`;
}

async function resolveDiscordWebhooks(webhookStore, store = null) {
  const dedicated = storedDiscordWebhooks(webhookStore);
  if (dedicated != null) {
    return discordWebhooksPayload(dedicated, {
      usingEnvFallback: false,
      source: 'webhook_store'
    });
  }

  const stored = storedDiscordWebhooks(store?.settings || {});
  const entries = stored ?? getDiscordWebhookUrls().map((url) => ({ name: '', url, enabled: true }));
  return discordWebhooksPayload(entries, {
    usingEnvFallback: stored == null,
    source: stored == null ? 'env' : 'legacy_settings'
  });
}

function normalizedUniqueBookInputs(inputs) {
  const parsed = Array.isArray(inputs)
    ? inputs.map(normalizeBookImportInput).filter(Boolean)
    : parseBookImportInputs(inputs);
  return [...new Map(parsed.map((input) => [bookImportQueueKey(input), input])).values()];
}

function importQueueSummary(queue = {}) {
  return {
    pendingCount: Array.isArray(queue.pending) ? queue.pending.length : 0,
    completedCount: Array.isArray(queue.completed) ? queue.completed.length : 0,
    errorCount: Array.isArray(queue.errors) ? queue.errors.length : 0
  };
}

function storedDiscordWebhookUrls(settings = {}) {
  if (Array.isArray(settings.discordWebhookUrls)) {
    return parseWebhookUrls(settings.discordWebhookUrls.join('\n'));
  }
  if (typeof settings.discordWebhookUrls === 'string') {
    return parseWebhookUrls(settings.discordWebhookUrls);
  }
  return null;
}

function storedDiscordWebhooks(settings = {}) {
  if (Array.isArray(settings.discordWebhooks)) {
    return normalizeDiscordWebhookEntries(settings.discordWebhooks);
  }
  const urls = storedDiscordWebhookUrls(settings);
  return urls == null ? null : normalizeDiscordWebhookEntries(urls);
}

function normalizeDiscordWebhookEntries(value) {
  const entries = normalizeWebhookEntries(value);
  for (const entry of entries) {
    if (!isValidDiscordWebhookUrl(entry.url)) {
      const error = new Error('Discord Webhook URL の形式が正しくありません');
      error.status = 400;
      throw error;
    }
  }
  return entries;
}

function activeDiscordWebhookUrls(entries = []) {
  return activeWebhookUrls(entries);
}

function discordWebhooksPayload(entries, extra = {}) {
  const normalized = normalizeDiscordWebhookEntries(entries);
  const urls = activeDiscordWebhookUrls(normalized);
  return {
    entries: normalized,
    urls,
    count: urls.length,
    totalCount: normalized.length,
    pausedCount: normalized.length - urls.length,
    ...extra
  };
}

function isValidDiscordWebhookUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      /(^|\.)discord(?:app)?\.com$/i.test(url.hostname) &&
      /^\/api\/webhooks\/\d+\/[^/]+$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function floorNumber(value, min, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.round(number));
}
