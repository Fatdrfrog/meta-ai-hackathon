import "server-only";

import type { BulkDispatchGcsClient } from "@icecore/shared/lib/bulk-dispatch-payload-store";
import {
  getGoogleCloudPlatformAccessToken,
  getGoogleCloudProjectId,
  hasVercelGcpWorkloadIdentityConfig,
} from "@/lib/google/gcp-auth";

/**
 * GCS client for Vercel Workload Identity Federation (same auth path as Pub/Sub).
 * Cloud Run worker keeps ADC via default `@google-cloud/storage` client.
 */
export function createVercelWifBulkDispatchGcsClient(): BulkDispatchGcsClient {
  return {
    bucket: (bucketName: string) => ({
      file: (objectPath: string) => ({
        save: async (data, options) => {
          const token = await getGoogleCloudPlatformAccessToken(
            getGoogleCloudProjectId("GOOGLE_CLOUD_PROJECT")
          );
          const body = Buffer.isBuffer(data)
            ? data
            : Buffer.from(String(data), "utf8");
          const contentType =
            options?.contentType ||
            options?.metadata?.contentType ||
            "application/json; charset=utf-8";
          const customTime = options?.metadata?.customTime;
          const customMetadata = options?.metadata?.metadata || {};

          const metadata: Record<string, unknown> = {
            name: objectPath,
            contentType,
            metadata: customMetadata,
          };
          if (customTime) {
            metadata.customTime = customTime;
          }

          const boundary = `bulk_dispatch_${Date.now().toString(16)}`;
          const metadataPart = Buffer.from(
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
              metadata
            )}\r\n`,
            "utf8"
          );
          const mediaHeader = Buffer.from(
            `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
            "utf8"
          );
          const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
          const multipart = Buffer.concat([
            metadataPart,
            mediaHeader,
            body,
            footer,
          ]);

          const url = new URL(
            `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
              bucketName
            )}/o`
          );
          url.searchParams.set("uploadType", "multipart");
          url.searchParams.set("name", objectPath);
          if (options?.preconditionOpts?.ifGenerationMatch !== undefined) {
            url.searchParams.set("ifGenerationMatch", String(options.preconditionOpts.ifGenerationMatch));
          }

          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            body: multipart,
          });
          if (!response.ok) {
            const text = await response.text();
            throw new Error(
              `GCS bulk dispatch upload failed: HTTP ${response.status} ${text.slice(0, 500)}`
            );
          }
        },
        download: async () => {
          const token = await getGoogleCloudPlatformAccessToken(
            getGoogleCloudProjectId("GOOGLE_CLOUD_PROJECT")
          );
          const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
            bucketName
          )}/o/${encodeURIComponent(objectPath)}?alt=media`;
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (response.status === 404) {
            const error = new Error("Not Found") as Error & { code?: number };
            error.code = 404;
            throw error;
          }
          if (!response.ok) {
            const text = await response.text();
            throw new Error(
              `GCS bulk dispatch download failed: HTTP ${response.status} ${text.slice(0, 500)}`
            );
          }
          return [Buffer.from(await response.arrayBuffer())];
        },
      }),
    }),
  };
}

export function shouldUseVercelWifBulkDispatchGcsClient(): boolean {
  return hasVercelGcpWorkloadIdentityConfig();
}
