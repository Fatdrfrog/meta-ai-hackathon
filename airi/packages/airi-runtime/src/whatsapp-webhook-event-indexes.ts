import WhatsAppWebhookEvent, {
  WHATSAPP_WEBHOOK_MANAGED_INDEXES,
} from "./whatsapp-webhook-event-model";

type WhatsAppWebhookIndexCache = {
  ensured: boolean;
  ensurePromise: Promise<void> | null;
};

const globalForWhatsAppWebhookIndexes = globalThis as typeof globalThis & {
  __whatsAppWebhookIndexCache?: WhatsAppWebhookIndexCache;
};

const indexCache =
  globalForWhatsAppWebhookIndexes.__whatsAppWebhookIndexCache ?? {
    ensured: false,
    ensurePromise: null,
  };

globalForWhatsAppWebhookIndexes.__whatsAppWebhookIndexCache = indexCache;

async function createWhatsAppWebhookEventIndexes() {
  for (const { key, options } of WHATSAPP_WEBHOOK_MANAGED_INDEXES) {
    await WhatsAppWebhookEvent.collection.createIndex(key, {
      ...options,
      background: true,
    });
  }
}

export async function ensureWhatsAppWebhookEventIndexes() {
  if (indexCache.ensured) return;
  if (indexCache.ensurePromise) return indexCache.ensurePromise;

  indexCache.ensurePromise = createWhatsAppWebhookEventIndexes()
    .then(() => {
      indexCache.ensured = true;
    })
    .catch((error) => {
      indexCache.ensurePromise = null;
      throw error;
    })
    .finally(() => {
      if (indexCache.ensured) {
        indexCache.ensurePromise = null;
      }
    });

  return indexCache.ensurePromise;
}
