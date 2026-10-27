import { randomUUID } from "node:crypto";

import {
  WHATSAPP_CATALOG_IMPORT_WORKFLOW,
  WHATSAPP_CATALOG_IMPORT_WORKFLOW_CONTRACT_VERSION,
  sanitizeTemporalWorkflowIdPart,
  type WhatsAppCatalogImportWorkflowInput,
} from "@icecore/temporal";

import { getTemporalClient, getTemporalWebClientConfig } from "./client";

export function buildWhatsAppCatalogImportWorkflowId(params: {
  workspaceId: string;
  catalogId: string;
}): string {
  const workspaceId = sanitizeTemporalWorkflowIdPart(
    params.workspaceId || "workspace"
  );
  const catalogId = sanitizeTemporalWorkflowIdPart(
    params.catalogId || "catalog"
  );
  return `whatsapp-catalog-import:${workspaceId}:${catalogId}:${Date.now()}-${randomUUID()}`;
}

export async function startWhatsAppCatalogImportWorkflow(
  input: Omit<WhatsAppCatalogImportWorkflowInput, "contractVersion">
) {
  const client = getTemporalClient();
  const config = getTemporalWebClientConfig();
  const workflowId = buildWhatsAppCatalogImportWorkflowId({
    workspaceId: input.workspaceId,
    catalogId: input.catalogId,
  });

  return client.workflow.start(WHATSAPP_CATALOG_IMPORT_WORKFLOW, {
    workflowId,
    taskQueue: config.taskQueue,
    args: [
      {
        contractVersion: WHATSAPP_CATALOG_IMPORT_WORKFLOW_CONTRACT_VERSION,
        ...input,
      },
    ],
  });
}
