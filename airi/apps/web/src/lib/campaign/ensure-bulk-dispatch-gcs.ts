import "server-only";

import { setBulkDispatchStorageClient } from "@icecore/shared/lib/bulk-dispatch-payload-store";
import {
  createVercelWifBulkDispatchGcsClient,
  shouldUseVercelWifBulkDispatchGcsClient,
} from "@/lib/campaign/bulk-dispatch-gcs-client";

let wired = false;

/**
 * Wire bulk staging GCS auth once per process:
 * - Vercel: existing Workload Identity Federation (same as Pub/Sub)
 * - else: leave shared ADC default (local gcloud / Cloud Run SA)
 */
export function ensureBulkDispatchGcsAuth(): void {
  if (wired) return;
  wired = true;
  if (shouldUseVercelWifBulkDispatchGcsClient()) {
    setBulkDispatchStorageClient(createVercelWifBulkDispatchGcsClient());
  }
}
