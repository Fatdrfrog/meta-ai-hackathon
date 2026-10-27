import { panelWorkspaceHref } from "@/features/panel/shared/routing/hrefs";
import {
  hasClientMessageReferralFilters,
  isClientMessageCriteriaMatchable,
  projectActiveClientMessageFilters,
} from "@/lib/scenarios/client-message-trigger-criteria";
import { readDate } from "@icecore/shared/lib/value-utils";
import type {
  ScenarioBuilderBulkRootSummary,
  ScenarioSummaryDTO,
  ScenarioTriggerConfig,
} from "@icecore/scenario-contracts";
import { z } from "zod";
import { boundedText } from "../redaction";
import type { AiriMcpAuthContext } from "../types";
import {
  arraySchema,
  BOOLEAN_SCHEMA,
  COUNT_SCHEMA,
  defineAiriMcpTool,
  enumSchema,
  NULLABLE_DATE_TIME_SCHEMA,
  NULLABLE_STRING_SCHEMA,
  objectSchema,
  STRING_SCHEMA,
} from "./define";

const SCENARIO_STATUS_FILTERS = ["active", "inactive", "all"] as const;
export const SCENARIOS_MAX_LIMIT = 100;
const SCENARIOS_DEFAULT_LIMIT = 50;
const CURSOR_MAX_LENGTH = 512;

export const listScenariosArgs = z
  .object({
    status: z.enum(SCENARIO_STATUS_FILTERS).default("all"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SCENARIOS_MAX_LIMIT)
      .default(SCENARIOS_DEFAULT_LIMIT),
    cursor: z
      .string()
      .min(1)
      .max(CURSOR_MAX_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
  })
  .strict();

/** Wording from the English Scenarios catalog (messages/scenarios/en). */
const MESSAGE_MATCH_WORDS = {
  any: "any message",
  exact: "exact match",
  contains: "contains keyword",
} as const;

export function describeScenarioTrigger(
  config: ScenarioTriggerConfig | null | undefined
): string {
  switch (config?.entryPointType) {
    case "whatsapp_qr":
      return "WhatsApp QR";
    case "customer_behavior":
      return "Customer behavior";
    case "business_event":
      return "Business event";
    default:
      break;
  }
  const criteria = projectActiveClientMessageFilters(config);
  if (!criteria.enabled) return "Customer message (trigger turned off)";
  const parts = [
    `Customer message: ${MESSAGE_MATCH_WORDS[criteria.text.mode]}`,
  ];
  // The runtime skips a keyword trigger whose pattern is missing or invalid.
  if (!isClientMessageCriteriaMatchable(criteria)) {
    parts.push(
      criteria.text.status === "invalid-regex"
        ? "never fires: the keyword pattern is invalid"
        : "never fires: no keyword set"
    );
  }
  if (criteria.onlyNewCustomers) parts.push("only new customers");
  if (criteria.channelFilter.length > 0) {
    parts.push(`channels: ${criteria.channelFilter.join(", ")}`);
  }
  if (hasClientMessageReferralFilters(criteria)) {
    parts.push("only messages from matching ads or referrals");
  }
  return parts.join("; ");
}

function describeBulkRoot(root: ScenarioBuilderBulkRootSummary): string {
  switch (root.workflowKind) {
    case "bulk_campaign":
      return "Bulk campaign";
    case "follow_up_workflow":
      return "Follow-up workflow start (sends no campaign)";
    default:
      return "Bulk start without a campaign setup";
  }
}

/** Entry points in plain words: bulk roots first, then triggers. */
function describeScenarioEntryPoints(scenario: ScenarioSummaryDTO): string {
  if (scenario.mode === "bulk_campaign") return "Bulk campaign audience";
  const bulkRoots = scenario.builderSummary?.bulkRoots ?? [];
  const triggers = scenario.builderSummary?.triggers ?? [];
  const entries = [
    ...bulkRoots.map(describeBulkRoot),
    ...triggers.map(trigger => describeScenarioTrigger(trigger.triggerConfig)),
  ];
  const [first] = entries;
  if (first === undefined) return "No trigger";
  if (entries.length === 1) return first;
  const noun = bulkRoots.length > 0 ? "entry points" : "triggers";
  return `${entries.length} ${noun} (first: ${first})`;
}

/**
 * Legacy campaigns carry Scenario.mode "bulk_campaign"; builder campaigns
 * keep mode "conversation" and are recognized by a bulk campaign root.
 */
function resolveScenarioMode(
  scenario: ScenarioSummaryDTO
): "conversation" | "bulk_campaign" {
  const hasCampaignRoot = (scenario.builderSummary?.bulkRoots ?? []).some(
    root => root.workflowKind === "bulk_campaign"
  );
  return scenario.mode === "bulk_campaign" || hasCampaignRoot
    ? "bulk_campaign"
    : "conversation";
}

function scenarioBuilderUrl(auth: AiriMcpAuthContext, id: string): string {
  const path = panelWorkspaceHref(auth.workspaceId, "scenarios");
  return `${auth.appOrigin}${path}?scenarioId=${encodeURIComponent(id)}`;
}

export function serializeScenario(
  scenario: ScenarioSummaryDTO,
  auth: AiriMcpAuthContext
) {
  // Trigger and bulk roots are entry points, not steps.
  const rootCount =
    (scenario.builderSummary?.triggers?.length ?? 0) +
    (scenario.builderSummary?.bulkRoots?.length ?? 0);
  return {
    id: scenario._id,
    name: boundedText(scenario.name, 200) ?? "Untitled scenario",
    active: scenario.status === "active",
    status: scenario.status,
    mode: resolveScenarioMode(scenario),
    trigger: describeScenarioEntryPoints(scenario),
    step_count: Math.max(0, scenario.nodeCount - rootCount),
    updated_at: readDate(scenario.updatedAt)?.toISOString() ?? null,
    builder_url: scenarioBuilderUrl(auth, scenario._id),
  };
}

const scenarioSchema = objectSchema({
  id: STRING_SCHEMA,
  name: STRING_SCHEMA,
  active: BOOLEAN_SCHEMA,
  status: enumSchema(["active", "draft"]),
  mode: enumSchema(["conversation", "bulk_campaign"]),
  trigger: STRING_SCHEMA,
  step_count: COUNT_SCHEMA,
  updated_at: NULLABLE_DATE_TIME_SCHEMA,
  builder_url: STRING_SCHEMA,
});

export const listScenariosTool = defineAiriMcpTool({
  name: "list_scenarios",
  title: "List scenarios",
  description:
    "Automation scenarios in this workspace, highest priority first: name, whether it is active, its trigger or campaign start in plain words, the number of steps, when it was last updated and a link to it in the scenario builder. mode is bulk_campaign for campaigns (a legacy campaign or a builder scenario with a bulk campaign start). Inactive means draft. The scenario graph itself is not returned.",
  scope: "catalog",
  inputSchema: objectSchema(
    {
      status: {
        ...enumSchema(SCENARIO_STATUS_FILTERS),
        default: "all",
        description: "active, inactive (draft) or all.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SCENARIOS_MAX_LIMIT,
        default: SCENARIOS_DEFAULT_LIMIT,
      },
      cursor: {
        type: "string",
        minLength: 1,
        maxLength: CURSOR_MAX_LENGTH,
        pattern: "^[A-Za-z0-9_-]+$",
        description: "next_cursor from the previous page.",
      },
    },
    []
  ),
  outputSchema: objectSchema({
    status_filter: enumSchema(SCENARIO_STATUS_FILTERS),
    limit: COUNT_SCHEMA,
    returned: COUNT_SCHEMA,
    has_more: BOOLEAN_SCHEMA,
    next_cursor: NULLABLE_STRING_SCHEMA,
    scenarios: arraySchema(scenarioSchema, SCENARIOS_MAX_LIMIT),
  }),
  args: listScenariosArgs,
  async run({ status, limit, cursor }, { auth, data }) {
    const result = await data.listScenarios({
      workspaceId: auth.workspaceId,
      status,
      limit,
      cursor,
    });
    const scenarios = result.items
      .slice(0, limit)
      .map(scenario => serializeScenario(scenario, auth));
    const activeCount = scenarios.filter(scenario => scenario.active).length;
    const more = result.hasMore ? " More are available with next_cursor." : "";

    return {
      summary: `Returned ${scenarios.length} scenario(s), ${activeCount} active.${more}`,
      structured: {
        status_filter: status,
        limit,
        returned: scenarios.length,
        has_more: result.hasMore,
        next_cursor: result.hasMore ? result.nextCursor : null,
        scenarios,
      },
      itemCount: scenarios.length,
    };
  },
});
