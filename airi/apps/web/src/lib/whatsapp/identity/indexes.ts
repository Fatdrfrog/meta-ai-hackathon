import Chat from "@/models/chat";
import User from "@/models/user";

type WhatsAppIdentityIndexCache = {
  ensured: boolean;
  ensurePromise: Promise<void> | null;
};

const globalForWhatsAppIdentityIndexes = globalThis as typeof globalThis & {
  __whatsAppIdentityIndexCache?: WhatsAppIdentityIndexCache;
};

const indexCache =
  globalForWhatsAppIdentityIndexes.__whatsAppIdentityIndexCache ?? {
    ensured: false,
    ensurePromise: null,
  };

globalForWhatsAppIdentityIndexes.__whatsAppIdentityIndexCache = indexCache;

async function createWhatsAppIdentityIndexesForCollection(collection: {
  createIndex: (
    keys: Record<string, 1 | -1>,
    options?: { background?: boolean }
  ) => Promise<string>;
}) {
  await collection.createIndex(
    { workspaceId: 1, "whatsapp.waId": 1 },
    { background: true }
  );
  await collection.createIndex(
    { workspaceId: 1, "whatsapp.previousWaIds": 1 },
    { background: true }
  );
  await collection.createIndex(
    { workspaceId: 1, "whatsapp.userId": 1 },
    { background: true }
  );
  await collection.createIndex(
    { workspaceId: 1, "whatsapp.previousUserIds": 1 },
    { background: true }
  );
  await collection.createIndex(
    { workspaceId: 1, "whatsapp.parentUserId": 1 },
    { background: true }
  );
}

async function createWhatsAppIdentityIndexes() {
  await createWhatsAppIdentityIndexesForCollection(User.collection);
  await createWhatsAppIdentityIndexesForCollection(Chat.collection);
}

export async function ensureWhatsAppIdentityIndexes() {
  if (indexCache.ensured) return;
  if (indexCache.ensurePromise) return indexCache.ensurePromise;

  indexCache.ensurePromise = createWhatsAppIdentityIndexes()
    .then(() => {
      indexCache.ensured = true;
    })
    .catch(error => {
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
