export const VIDEO_GENERATION_RECONCILE_WORKFLOW =
  "videoGenerationReconcileWorkflow";
export const VIDEO_GENERATION_RECONCILE_ACTIVITY =
  "videoGenerationReconcileActivity";
export const VIDEO_GENERATION_RECONCILE_WORKFLOW_CONTRACT_VERSION = 1;
export const VIDEO_GENERATION_RECONCILE_SCHEDULE_ID =
  "airi-video-generation-orchestration-reconcile";
// Normal generation starts immediately; reconciliation repairs missed starts.
export const VIDEO_GENERATION_RECONCILE_SCHEDULE_INTERVAL_MS = 5 * 60_000;
export const VIDEO_GENERATION_RECONCILE_SCHEDULE_CATCHUP_WINDOW_MS = 60_000;
export const VIDEO_GENERATION_RECONCILE_STALE_MS = 60_000;
export const VIDEO_GENERATION_RECONCILE_RUNNING_STALE_MS = 10 * 60_000;
export const VIDEO_GENERATION_RECONCILE_LIMIT = 100;

export type VideoGenerationReconcileWorkflowInput = {
  contractVersion: 1;
};

export type VideoGenerationReconcileActivityResult = {
  contractVersion: 1;
  scanned: number;
  started: number;
  alreadyStarted: number;
  markedStarted: number;
  unknown: number;
  invalid: number;
  unscoped: number;
  quarantined: number;
  closed: number;
  closedFailed: number;
  casMisses: number;
};
