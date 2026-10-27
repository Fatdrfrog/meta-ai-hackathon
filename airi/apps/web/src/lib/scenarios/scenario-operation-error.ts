import type { CompanyConversationLimitSnapshot } from "@/lib/limits/company-limits";
import type { ScenarioGraphValidationErrorKey } from "@/lib/scenarios/graph-validation";
import type { LegacyRoutingConversionError } from "@/lib/scenarios/legacy-routing-conversion-service";

export type ScenarioOperationFailure =
  | { kind: "not_found" }
  | {
      kind: "revision_conflict";
      currentUpdatedAt: Date | null;
      operation: "save" | "delete";
    }
  | { kind: "graph_payload_invalid" }
  | {
      kind: "graph_invalid";
      code: ScenarioGraphValidationErrorKey;
      nodeIds?: string[];
    }
  | { kind: "subscenario_links_invalid"; codes: string[] }
  | { kind: "linked_conditions_invalid"; codes: string[] }
  | { kind: "legacy_assignment_forbidden" }
  | { kind: "legacy_conversion_invalid" }
  | { kind: "legacy_conversion_failed"; error: LegacyRoutingConversionError }
  | { kind: "qr_binding_changed"; code: string; nodeId: string; change: string }
  | { kind: "qr_activation_conflict"; message: string }
  | { kind: "birthday_conflict"; scenarioId: string; name: string | null }
  | { kind: "delete_confirmation_required" | "delete_confirmation_mismatch" }
  | {
      kind: "conversation_capacity" | "scenario_capacity";
      limit: CompanyConversationLimitSnapshot;
    };

/** Expected operation failures; transport owners decide how to present them. */
export class ScenarioOperationError extends Error {
  constructor(readonly failure: ScenarioOperationFailure) {
    super(failure.kind);
    this.name = "ScenarioOperationError";
  }
}
