import {
  MAX_SCENARIO_NAME_LENGTH,
  isScenarioViewport,
  readScenarioGraphEnvelope,
} from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";
import { NextResponse } from "next/server";
import {
  buildCompanyLimitExceededResponse,
  buildCompanyScenarioLimitExceededResponse,
} from "@/lib/limits/company-limits";
import { ScenarioOperationError } from "@/lib/scenarios/scenario-operation-error";
import { LINKED_CONDITION_ERROR_CODES } from "@/lib/scenarios/linked-conditions";
import {
  LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE,
  LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_MESSAGE,
} from "@/lib/scenarios/legacy-action-routing";

export function buildScenarioNameValidationError(
  value: unknown
): NextResponse | null {
  if (
    typeof value !== "string" ||
    value.trim().length <= MAX_SCENARIO_NAME_LENGTH
  ) {
    return null;
  }
  return NextResponse.json(
    {
      error: `Scenario name must be ${MAX_SCENARIO_NAME_LENGTH} characters or fewer`,
      code: "scenario_name_too_long",
      maxLength: MAX_SCENARIO_NAME_LENGTH,
    },
    { status: 400 }
  );
}

/** Check the wire shape before migration or any typed graph/provider consumers. */
export function buildScenarioGraphPayloadValidationError(
  payload: unknown
): NextResponse | null {
  if (isRecord(payload)) {
    const record = payload;
    const graph = readScenarioGraphEnvelope({
      nodes: record.nodes === undefined ? [] : record.nodes,
      edges: record.edges === undefined ? [] : record.edges,
    });
    if (
      graph &&
      (record.viewport === undefined || isScenarioViewport(record.viewport))
    ) {
      return null;
    }
  }
  return NextResponse.json(
    { error: "Invalid scenario graph payload", code: "scenario_graph_invalid" },
    { status: 400 }
  );
}

/** Preserve the public CRUD error contract without coupling operations to Next. */
export function mapScenarioOperationError(error: unknown): NextResponse | null {
  if (!(error instanceof ScenarioOperationError)) return null;
  const failure = error.failure;
  switch (failure.kind) {
    case "not_found":
      return NextResponse.json(
        { error: "Scenario not found" },
        { status: 404 }
      );
    case "revision_conflict":
      return NextResponse.json(
        {
          error:
            failure.operation === "delete"
              ? "This scenario changed in another tab or session. Reload the latest version before deleting it."
              : "This scenario changed in another tab or session. Reload the latest version before saving again.",
          code: "scenario_updated_conflict",
          currentUpdatedAt: failure.currentUpdatedAt?.toISOString() ?? null,
        },
        { status: 409 }
      );
    case "graph_payload_invalid":
      return NextResponse.json(
        {
          error: "Invalid scenario graph payload",
          code: "scenario_graph_invalid",
        },
        { status: 400 }
      );
    case "graph_invalid":
      return NextResponse.json(
        {
          error: "Invalid scenario graph",
          code: failure.code,
          ...(failure.nodeIds && failure.nodeIds.length > 0
            ? { nodeIds: failure.nodeIds }
            : {}),
        },
        { status: 400 }
      );
    case "subscenario_links_invalid":
      return NextResponse.json(
        { error: "Invalid sub-scenario links", codes: failure.codes },
        { status: 400 }
      );
    case "linked_conditions_invalid":
      return NextResponse.json(
        {
          error: failure.codes.includes(
            LINKED_CONDITION_ERROR_CODES.missingChildTrigger
          )
            ? "Linked sub-scenario must include a trigger node"
            : "Conditional sub-scenario link conflicts with an existing shared condition",
          codes: failure.codes,
        },
        {
          status: failure.codes.includes(
            LINKED_CONDITION_ERROR_CODES.conflictingChildReuse
          )
            ? 409
            : 400,
        }
      );
    case "legacy_assignment_forbidden":
      return NextResponse.json(
        {
          error: LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_MESSAGE,
          code: LEGACY_ACTION_ROUTING_NEW_ASSIGNMENT_FORBIDDEN_CODE,
        },
        { status: 400 }
      );
    case "legacy_conversion_invalid":
      return NextResponse.json(
        {
          error: "Invalid legacy routing conversion request",
          code: "legacy_action_routing_invalid_request",
        },
        { status: 400 }
      );
    case "legacy_conversion_failed":
      return NextResponse.json(
        { error: failure.error.message, code: failure.error.code },
        { status: failure.error.status }
      );
    case "qr_binding_changed":
      return NextResponse.json(
        {
          error:
            "WhatsApp QR assignments must be changed through the assignment command.",
          code: failure.code,
          nodeId: failure.nodeId,
          change: failure.change,
        },
        { status: 409 }
      );
    case "qr_activation_conflict":
      return NextResponse.json(
        { error: failure.message, code: "whatsapp_qr_activation_conflict" },
        { status: 409 }
      );
    case "birthday_conflict":
      return NextResponse.json(
        {
          error:
            "Only one active birthday campaign scenario can run in a workspace.",
          code: "birthday_scenario_already_active",
          conflictScenarioId: failure.scenarioId,
          conflictScenarioName: failure.name,
        },
        { status: 409 }
      );
    case "delete_confirmation_required":
      return NextResponse.json(
        {
          error: "Scenario delete confirmation is required",
          code: "scenario_delete_confirmation_required",
        },
        { status: 400 }
      );
    case "delete_confirmation_mismatch":
      return NextResponse.json(
        {
          error:
            "Scenario delete confirmation does not match the current scenario",
          code: "scenario_delete_confirmation_mismatch",
        },
        { status: 409 }
      );
    case "conversation_capacity":
      return buildCompanyLimitExceededResponse(failure.limit);
    case "scenario_capacity":
      return buildCompanyScenarioLimitExceededResponse(failure.limit);
  }
}
