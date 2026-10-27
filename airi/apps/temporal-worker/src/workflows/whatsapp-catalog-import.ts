import {
  assertContractVersion,
  WHATSAPP_CATALOG_IMPORT_BATCH_ACTIVITY,
  type WhatsAppCatalogImportBatchInput,
  type WhatsAppCatalogImportBatchResult,
  type WhatsAppCatalogImportWorkflowInput,
  type WhatsAppCatalogImportWorkflowResult,
} from "@icecore/temporal";
import { proxyActivities, setWorkflowOptions } from "@temporalio/workflow";

const importActivities = proxyActivities<{
  [WHATSAPP_CATALOG_IMPORT_BATCH_ACTIVITY]: (
    input: WhatsAppCatalogImportBatchInput,
  ) => Promise<WhatsAppCatalogImportBatchResult>;
}>({
  startToCloseTimeout: "300s",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2s",
    backoffCoefficient: 2,
    maximumInterval: "60s",
  },
});

const importBatchActivity = importActivities[
  WHATSAPP_CATALOG_IMPORT_BATCH_ACTIVITY
] as (
  input: WhatsAppCatalogImportBatchInput,
) => Promise<WhatsAppCatalogImportBatchResult>;

export async function whatsappCatalogImportWorkflow(
  input: WhatsAppCatalogImportWorkflowInput,
): Promise<WhatsAppCatalogImportWorkflowResult> {
  assertContractVersion(
    input.contractVersion,
    { exact: 1 },
    "WhatsApp catalog import workflow",
  );

  if (!input.items.length) {
    return {
      workspaceId: input.workspaceId,
      catalogId: input.catalogId,
      processed: 0,
      successful: 0,
      failed: 0,
      batchCount: 0,
    };
  }

  const batchSize = Math.min(
    Math.max(1, Math.floor(input.batchSize || 100)),
    100,
  );
  let processed = 0;
  let successful = 0;
  let failed = 0;
  let batchCount = 0;

  for (let offset = 0; offset < input.items.length; offset += batchSize) {
    const batch = input.items.slice(offset, offset + batchSize);
    const result = await importBatchActivity({
      accessToken: input.accessToken,
      catalogId: input.catalogId,
      items: batch,
      offset,
    });
    processed += result.processed;
    successful += result.successful;
    failed += result.failed;
    batchCount += 1;
  }

  return {
    workspaceId: input.workspaceId,
    catalogId: input.catalogId,
    processed,
    successful,
    failed,
    batchCount,
  };
}

setWorkflowOptions(
  { versioningBehavior: "AUTO_UPGRADE" },
  whatsappCatalogImportWorkflow,
);
