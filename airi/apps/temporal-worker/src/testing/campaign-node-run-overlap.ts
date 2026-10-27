import type { CampaignNodeRunWorkflowInput } from "@icecore/temporal";
import { campaignNodeRunWorkflow } from "../workflows/campaign-node-run.js";

export { campaignExecutionWorkflow } from "../workflows/campaign-node-run.js";

export async function birthdayOccurrenceOverlapWorkflow(
  input: CampaignNodeRunWorkflowInput,
) {
  const first = await campaignNodeRunWorkflow(input);
  const second = await campaignNodeRunWorkflow({
    ...input,
    scheduledFor: "2099-04-17T10:00:00.000Z",
  });
  return [first, second];
}
