/**
 * Temporal + web schedule reconcile (bulk-campaign scenario nodes).
 */
export type CampaignNodeScheduleReconcileResult = {
  ok: boolean;
  action:
    | "created"
    | "updated"
    | "paused"
    | "resumed"
    | "deleted"
    | "noop"
    | "not_configured"
    | "invalid"
    | "error";
  scheduleId?: string;
  cronExpression?: string;
  configHash?: string;
  errorMessage?: string;
};

export type CampaignScenarioScheduleReconcileSummary = {
  reconciled: CampaignNodeScheduleReconcileResult[];
  orphanedDeletes: CampaignNodeScheduleReconcileResult[];
};

export type CampaignScheduleReconcileActivityInput = {
  contractVersion: number;
  workspaceId: string;
  scenarioId: string;
};

export type CampaignScheduleReconcileWorkflowInput =
  CampaignScheduleReconcileActivityInput;

export type CampaignScheduleReconcileWorkflowResult =
  CampaignScenarioScheduleReconcileSummary;
