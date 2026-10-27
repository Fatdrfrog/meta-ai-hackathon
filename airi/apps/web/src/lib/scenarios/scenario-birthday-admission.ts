import {
  isBuilderBirthdayCampaignRoot,
  resolveScheduledCampaignNode,
  resolveScheduledCampaignNodeChannel,
  type CampaignEdgeRecord,
  type CampaignNodeRecord,
} from "@/lib/campaign/campaign-runtime-utils";
import { importCustomerBirthdays } from "@/lib/customers/customer-birthday-import";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import { isRecord } from "@icecore/shared/lib/value-utils";
import { serializeStableJson } from "@/lib/campaign/bulk-campaign-content-hash";

type BirthdayScenarioImportGraph = {
  mode: unknown;
  status: unknown;
  nodes: CampaignNodeRecord[];
  edges: CampaignEdgeRecord[];
};

function getBuilderBirthdayImportInputs(graph: BirthdayScenarioImportGraph) {
  if (graph.mode === "bulk_campaign") return [];
  return graph.nodes.filter(isBuilderBirthdayCampaignRoot).map(root => {
    const config = isRecord(root.data?.bulkRootConfig)
      ? root.data.bulkRootConfig
      : {};
    const scheduledNode = resolveScheduledCampaignNode({
      node: root,
      nodes: graph.nodes,
      edges: graph.edges,
    });
    const channel = resolveScheduledCampaignNodeChannel(
      scheduledNode?.data?.channel
    );
    return {
      rootId: String(root.id),
      channel,
      sourceId:
        channel === "telegram"
          ? String(scheduledNode?.data?.telegramSourceId || "").trim()
          : null,
      recipients: Array.isArray(config.uploadedRecipients)
        ? config.uploadedRecipients
        : [],
    };
  });
}

/**
 * Admission reuses the durable importer because the toolbar can activate while
 * the UI's asynchronous CSV import is still pending or has failed.
 */
export async function admitBuilderBirthdayScenarioAudience(
  params: BirthdayScenarioImportGraph & {
    workspaceId: string;
    previous?: BirthdayScenarioImportGraph;
  }
): Promise<void> {
  if (params.mode === "bulk_campaign" || params.status !== "active") return;
  const previousInputs = new Map(
    (params.previous
      ? getBuilderBirthdayImportInputs(params.previous)
      : []
    ).map(input => [input.rootId, input])
  );
  for (const input of getBuilderBirthdayImportInputs(params)) {
    // A graph save often changes just placement or message text. Reimporting
    // its old CSV would overwrite later profile corrections, so compare only
    // the canonical importer inputs and always recheck an activation.
    if (
      params.previous?.status === "active" &&
      serializeStableJson(previousInputs.get(input.rootId)) ===
        serializeStableJson(input)
    )
      continue;
    const { rootId, recipients, channel, sourceId } = input;
    const rejectAudience = () => {
      throw new ScenarioOperationError({
        kind: "graph_invalid",
        code: "birthdayRecipientsRequired",
        nodeIds: [rootId],
      });
    };
    if (recipients.length === 0) rejectAudience();
    if (channel !== "whatsapp" && channel !== "telegram") {
      throw new ScenarioOperationError({
        kind: "graph_invalid",
        code: "birthdayChannelUnsupported",
        nodeIds: [rootId],
      });
    }
    if (channel === "telegram" && !sourceId) {
      throw new ScenarioOperationError({
        kind: "graph_invalid",
        code: "birthdayTelegramSourceRequired",
        nodeIds: [rootId],
      });
    }
    // The importer owns birthday/identity parsing, subscriber eligibility,
    // batched persistence, and import transaction retries.
    const result = await importCustomerBirthdays({
      workspaceId: params.workspaceId,
      channel,
      ...(sourceId ? { sourceId } : {}),
      recipients: recipients as Parameters<
        typeof importCustomerBirthdays
      >[0]["recipients"],
    });
    if (result.imported + result.updated === 0) rejectAudience();
  }
}
