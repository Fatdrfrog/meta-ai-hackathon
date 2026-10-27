export const HIGGSFIELD_ASSET_GENERATION_WORKFLOW =
  "higgsfieldAssetGenerationWorkflow";

export const HIGGSFIELD_ASSET_GENERATION_WORKFLOW_CONTRACT_VERSION = 1;

export const HIGGSFIELD_SUBMIT_GENERATION_ACTIVITY =
  "higgsfieldSubmitGenerationActivity";

export const HIGGSFIELD_PROCESS_WEBHOOK_ACTIVITY =
  "higgsfieldProcessWebhookActivity";

export const HIGGSFIELD_POLL_STATUS_ACTIVITY = "higgsfieldPollStatusActivity";

export const HIGGSFIELD_GENERATION_WEBHOOK_SIGNAL =
  "higgsfieldGenerationWebhook";

export const HIGGSFIELD_GENERATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const HIGGSFIELD_STATUS_POLL_INTERVAL_MS = 5 * 60 * 1000;

export type HiggsfieldGenerationMode = "text_to_image" | "image_to_video";

export type HiggsfieldProviderLifecycleStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "nsfw"
  | "cancelled";

export type HiggsfieldAssetGenerationWorkflowInput = {
  contractVersion: number;
  workspaceId: string;
  assetId: string;
  mode: HiggsfieldGenerationMode;
  prompt: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  duration?: number | null;
  sourceAssetId?: string | null;
  providerSourceId?: string | null;
  imageUrl?: string | null;
  timeoutMs?: number | null;
};

export type HiggsfieldAssetGenerationWebhookSignalInput = {
  requestId?: string | null;
  status: HiggsfieldProviderLifecycleStatus;
  payload: Record<string, unknown>;
  receivedAt?: string | null;
};

export type HiggsfieldSubmitGenerationActivityResult = {
  assetId: string;
  providerRequestId: string;
  providerStatusUrl?: string | null;
  providerCancelUrl?: string | null;
  status: HiggsfieldProviderLifecycleStatus;
};

export type HiggsfieldPollStatusActivityInput = {
  contractVersion: number;
  assetId: string;
  providerRequestId: string;
  providerStatusUrl?: string | null;
};

export type HiggsfieldProcessWebhookActivityInput = {
  contractVersion: number;
  assetId: string;
  webhook: HiggsfieldAssetGenerationWebhookSignalInput;
};

export type HiggsfieldProcessWebhookActivityResult = {
  assetId: string;
  status: "queued" | "in_progress" | "complete" | "failed" | "nsfw";
  terminal: boolean;
  duplicate?: boolean;
};

export type HiggsfieldAssetGenerationWorkflowResult =
  HiggsfieldProcessWebhookActivityResult;

export function sanitizeHiggsfieldWorkflowIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-");
}

export function buildHiggsfieldAssetGenerationWorkflowId(params: {
  assetId: string;
}): string {
  const assetId = sanitizeHiggsfieldWorkflowIdPart(params.assetId || "asset");
  return `higgsfield-asset:${assetId}`;
}
