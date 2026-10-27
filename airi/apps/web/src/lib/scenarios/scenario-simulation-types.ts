import { z } from "zod";
import type {
  ScenarioGraphNode,
  ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";

export const scenarioSimulationEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }),
  z.object({
    kind: z.literal("message"),
    text: z.string().trim().min(1).max(4096),
  }),
  z.object({ kind: z.literal("choice"), payload: z.string().min(1).max(512) }),
  z.object({
    kind: z.literal("flow"),
    values: z
      .record(
        z.string().max(80),
        z.union([z.string().max(1024), z.array(z.string().max(1024)).max(100)])
      )
      .refine(
        values => Object.keys(values).length <= 100,
        "Too many Flow fields"
      ),
  }),
  z.object({
    kind: z.literal("advance"),
    minutes: z.number().positive().max(525600),
  }),
  z.object({ kind: z.literal("payment") }),
]);
export type ScenarioSimulationEvent = z.infer<
  typeof scenarioSimulationEventSchema
>;

export const scenarioSimulationStateSchema = z.object({
  graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  handoffActive: z.boolean(),
  status: z.enum(["waiting", "completed", "handoff", "blocked"]),
  actionNodeId: z.string().max(200).nullable(),
  nextActionNodeId: z.string().max(200).nullable(),
  triggerNodeId: z.string().max(200).nullable(),
  pendingConditionNodeId: z.string().max(400).nullable(),
  pendingSourceActionNodeId: z.string().max(200).nullable(),
  now: z.number().finite().nonnegative().max(3e13),
  waitStartedAt: z.number().finite().nonnegative().max(3e13),
  latestActivityAt: z.number().finite().nonnegative().max(3e13),
  dueAt: z.number().finite().nonnegative().max(3e13).nullable(),
  textSinceWait: z.array(z.string().max(4096)).max(200),
});
export type ScenarioSimulationState = z.infer<
  typeof scenarioSimulationStateSchema
>;
export type ScenarioSimulationGraph = {
  nodes: ScenarioGraphNode[];
  edges: Array<{
    id?: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }>;
};
export type ScenarioSimulationContext = {
  classificationCategory?: string;
  internalLabels?: string[];
  funnelStage?: string;
  hasPurchaseHistory?: boolean;
};
export type ScenarioSimulationMessage = {
  actionNodeId: string;
  bodyText: string;
  dynamic: boolean;
  serviceMessage?: ScenarioWhatsAppServiceMessage;
};
export const scenarioSimulationMessageSchema = z.object({
  actionNodeId: z.string().max(200),
  bodyText: z.string().max(20000),
  dynamic: z.boolean(),
  serviceMessage: z.unknown().optional(),
});
export type ScenarioSimulationResult = {
  state: ScenarioSimulationState;
  message: ScenarioSimulationMessage | null;
  pathNodeIds: string[];
  pathEdgeIds: string[];
  reason?: "no_match" | "cancelled" | "unsupported_action";
};
export const scenarioSimulationResultSchema = z.object({
  state: scenarioSimulationStateSchema,
  message: scenarioSimulationMessageSchema.nullable(),
  pathNodeIds: z.array(z.string().max(200)).max(1000),
  pathEdgeIds: z.array(z.string().max(200)).max(4000),
  reason: z.enum(["no_match", "cancelled", "unsupported_action"]).optional(),
});
