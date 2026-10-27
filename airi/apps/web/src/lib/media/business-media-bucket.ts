/**
 * Public bucket for business assets that providers fetch by a stable link:
 * WhatsApp template headers (including landing demos), generated scenario
 * media and studio uploads. They used to share the chat media buckets, which
 * hold end-customer media and are being made private.
 */

import { CUSTOMER_MEDIA_BUCKET_NAMES } from "@/lib/storage-buckets";

export const BUSINESS_MEDIA_BUCKET = "business-media";
/** Same per-object ceiling as the chat bucket these assets came from. */
export const BUSINESS_MEDIA_FILE_SIZE_LIMIT_BYTES = 20 * 1024 * 1024;

/** Prefixes that hold business assets, identical in the old and new bucket. */
export const BUSINESS_MEDIA_PREFIXES = [
  "whatsapp-template-headers/",
  "scenarios/",
  "studio/",
] as const;

/** Chat buckets that still hold legacy copies of business assets. */
export const LEGACY_BUSINESS_MEDIA_BUCKETS = CUSTOMER_MEDIA_BUCKET_NAMES;

export function resolveBusinessMediaBucket(override?: string | null): string {
  return override?.trim() || BUSINESS_MEDIA_BUCKET;
}

type BucketStorage = {
  getBucket(id: string): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
  createBucket(
    id: string,
    options: { public: boolean; fileSizeLimit?: number | string | null }
  ): PromiseLike<{ error: { message: string } | null }>;
};

const ensuredBuckets = new Map<string, Promise<void>>();

/**
 * Creates the public bucket on first use so deploys do not depend on a manual
 * step. A failed attempt is forgotten and retried on the next upload.
 */
export function ensureBusinessMediaBucket(
  storage: BucketStorage,
  bucket: string = BUSINESS_MEDIA_BUCKET
): Promise<void> {
  const existing = ensuredBuckets.get(bucket);
  if (existing) return existing;

  const ensured = (async () => {
    const { data, error } = await storage.getBucket(bucket);
    if (data && !error) return;
    const { error: createError } = await storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: BUSINESS_MEDIA_FILE_SIZE_LIMIT_BYTES,
    });
    if (createError && !/already exists/i.test(createError.message)) {
      throw new Error(
        `Failed to prepare business media storage: ${createError.message}`
      );
    }
  })();
  ensuredBuckets.set(bucket, ensured);
  ensured.catch(() => ensuredBuckets.delete(bucket));
  return ensured;
}

/**
 * Rewrites every public URL of a business asset in a legacy chat bucket to
 * the same object in the business media bucket. Other text is unchanged.
 */
export function rewriteLegacyBusinessMediaUrls(
  text: string,
  bucket: string = BUSINESS_MEDIA_BUCKET
): string {
  let rewritten = text;
  for (const legacyBucket of LEGACY_BUSINESS_MEDIA_BUCKETS) {
    for (const prefix of BUSINESS_MEDIA_PREFIXES) {
      rewritten = rewritten
        .split(`/storage/v1/object/public/${legacyBucket}/${prefix}`)
        .join(`/storage/v1/object/public/${bucket}/${prefix}`);
    }
  }
  return rewritten;
}
