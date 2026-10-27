import connectDB from "@/lib/mongoose";
import { createServerLogger } from "@/lib/observability/server-logs";
import { requireWorkspaceApiAccess } from "@/lib/supabase/workspace-api-access";
import { mutateScenarioGraphWithCas } from "@/lib/scenarios/scenario-graph-mutation";
import {
  createGeneratedTemplateTargetDigest,
  type GeneratedTemplateScenarioPatch,
  type GeneratedTemplateScenarioUpdate,
} from "@/lib/scenarios/generated-template-submission";
import { buildWhatsAppTemplateButtonIdsPatch } from "@/lib/scenarios/whatsapp-template-button-branches";
import { createWhatsAppTemplateMutation } from "@/lib/whatsapp/templates/mutation-service";
import { Scenario } from "@/models/scenario";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import type {
  ScenarioGeneratedTemplateDraft,
  ScenarioNodeData,
} from "@icecore/scenario-contracts";
import { Types } from "mongoose";
import { NextRequest, NextResponse } from "next/server";

type Params = Promise<{ workspaceId: string }>;

const scenarioTemplateSubmitLogger = createServerLogger(
  "api.scenario-generator.submit-template"
);

type SubmitTemplateBody = {
  scenarioId?: string;
  nodeId?: string;
  name?: string;
  language?: string;
  category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  components?: WhatsAppComponent[];
  expectedUpdatedAt?: string;
};

type ScenarioGeneratorTemplateDraft = ScenarioGeneratedTemplateDraft;

type ScenarioGeneratorNode = {
  id?: string;
  data?: Partial<ScenarioNodeData>;
  [key: string]: unknown;
};

type ScenarioGeneratorLean = {
  nodes?: ScenarioGeneratorNode[];
  updatedAt?: Date | string;
};

type TemplateDraftMutationValue =
  | {
      applied: true;
      reason: null;
      patch: GeneratedTemplateScenarioPatch;
    }
  | { applied: false; reason: "target_changed" };

function normalizeDraftStatus(
  status: string
): ScenarioGeneratedTemplateDraft["status"] {
  const normalized = status.trim().toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "rejected") return "rejected";
  if (normalized === "pending") return "pending";
  return "submitted";
}

function normalizeRevision(value: unknown): string | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function mutateGeneratedTemplateDraft(params: {
  workspaceId: string;
  scenarioId: string;
  nodeId: string;
  baselineTargetDigest: string;
  updatedBy: string;
  patch: (
    draft: ScenarioGeneratorTemplateDraft,
    data: Partial<ScenarioNodeData>
  ) => GeneratedTemplateScenarioPatch;
}) {
  const result = await mutateScenarioGraphWithCas<TemplateDraftMutationValue>({
    workspaceId: params.workspaceId,
    scenarioId: params.scenarioId,
    updatedBy: params.updatedBy,
    project: snapshot => {
      const nodes = snapshot.nodes as ScenarioGeneratorNode[];
      const target = nodes.find(node => node?.id === params.nodeId);
      const draft = target?.data?.generatedTemplateDraft;
      if (
        !target ||
        !target.data ||
        !draft ||
        createGeneratedTemplateTargetDigest(target.data) !==
          params.baselineTargetDigest
      ) {
        return {
          changed: false,
          value: { applied: false, reason: "target_changed" },
        };
      }

      const patch = params.patch(draft, target.data);

      return {
        changed: true,
        nodes: nodes.map(node =>
          node?.id === params.nodeId
            ? { ...node, data: { ...node.data, ...patch } }
            : node
        ),
        edges: snapshot.edges,
        value: { applied: true, reason: null, patch },
      };
    },
  });

  if (result.status === "not_found") {
    return { applied: false as const, reason: "scenario_not_found" as const };
  }
  if (result.status === "conflict") {
    return { applied: false as const, reason: "revision_conflict" as const };
  }
  if (!result.value.applied) return result.value;
  return {
    ...result.value,
    scenarioUpdate: {
      nodeId: params.nodeId,
      previousScenarioUpdatedAt: result.previousScenarioUpdatedAt,
      scenarioUpdatedAt: result.scenarioUpdatedAt,
      patch: result.value.patch,
    } satisfies GeneratedTemplateScenarioUpdate,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Params }
) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceApiAccess(workspaceId);
  if (!access.ok) return access.response;

  const body = (await request.json().catch(() => ({}))) as SubmitTemplateBody;
  const scenarioId = String(body.scenarioId || "").trim();
  const nodeId = String(body.nodeId || "").trim();
  const expectedUpdatedAt = String(body.expectedUpdatedAt || "").trim();
  if (!Types.ObjectId.isValid(scenarioId) || !nodeId) {
    return NextResponse.json(
      { error: "scenarioId and nodeId are required" },
      { status: 400 }
    );
  }

  await connectDB();
  const scenario = await Scenario.findOne({
    _id: new Types.ObjectId(scenarioId),
    workspaceId,
    deletedAt: null,
  }).lean<ScenarioGeneratorLean | null>();
  if (!scenario) {
    return NextResponse.json({ error: "Scenario not found" }, { status: 404 });
  }

  const scenarioUpdatedAt = normalizeRevision(scenario.updatedAt);
  if (expectedUpdatedAt && scenarioUpdatedAt !== expectedUpdatedAt) {
    return NextResponse.json(
      { error: "Scenario changed before submitting the generated template" },
      { status: 409 }
    );
  }

  const nodes = Array.isArray(scenario.nodes) ? scenario.nodes : [];
  const target = nodes.find(node => node?.id === nodeId);
  const draft = target?.data?.generatedTemplateDraft;
  const blockedStatus = new Set([
    "submitting",
    "submitted",
    "pending",
    "approved",
  ]);
  const name = String(body.name || draft?.name || "").trim();
  const requestedLanguage = String(
    body.language || draft?.language || "en"
  ).trim();
  const language = normalizeWhatsAppTemplateLanguageCode(requestedLanguage);
  const category = (body.category ||
    draft?.category ||
    "MARKETING") as NonNullable<SubmitTemplateBody["category"]>;
  const components = Array.isArray(body.components)
    ? body.components
    : Array.isArray(draft?.components)
      ? draft.components
      : undefined;

  if (!target || !draft || !name || !requestedLanguage || !components?.length) {
    return NextResponse.json(
      {
        error: !language
          ? `Unsupported WhatsApp template language code: ${requestedLanguage}`
          : "Generated template draft is incomplete",
      },
      { status: 400 }
    );
  }
  if (!language) {
    return NextResponse.json(
      {
        error: `Unsupported WhatsApp template language code: ${requestedLanguage}`,
      },
      { status: 400 }
    );
  }
  if (draft.status && blockedStatus.has(draft.status)) {
    return NextResponse.json(
      { error: "Generated template draft was already submitted" },
      { status: 409 }
    );
  }
  const baselineTargetDigest = createGeneratedTemplateTargetDigest(
    target.data ?? {}
  );

  let result: Awaited<ReturnType<typeof createWhatsAppTemplateMutation>>;
  try {
    result = await createWhatsAppTemplateMutation({
      workspaceId,
      userId: access.userId,
      name,
      language: requestedLanguage,
      category,
      components,
      allowCategoryChange: true,
      analyticsOrigin: "scenario_generator",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to submit template";
    const rejectionMutation = await mutateGeneratedTemplateDraft({
      workspaceId,
      scenarioId,
      nodeId,
      baselineTargetDigest,
      updatedBy: access.userId,
      patch: currentDraft => ({
        generatedTemplateDraft: {
          ...currentDraft,
          status: "rejected",
          error: message,
        },
      }),
    });
    if (!rejectionMutation.applied) {
      return NextResponse.json(
        {
          error: "Scenario changed while submitting the generated template",
          reason: rejectionMutation.reason,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: message, scenarioUpdate: rejectionMutation.scenarioUpdate },
      { status: 400 }
    );
  }

  const nextStatus = normalizeDraftStatus(result.status || "submitted");
  const graphMutation = await mutateGeneratedTemplateDraft({
    workspaceId,
    scenarioId,
    nodeId,
    baselineTargetDigest,
    updatedBy: access.userId,
    patch: (currentDraft, current) => ({
      actionWhatsAppTemplateId: result.id,
      actionWhatsAppTemplateName: name,
      actionWhatsAppTemplateLanguage: language,
      actionWhatsAppTemplateCategory: category,
      actionWhatsAppTemplateComponents: components,
      // Routes stay on the reply buttons they were drawn from.
      ...buildWhatsAppTemplateButtonIdsPatch({
        previous: current,
        components,
        match: "byIndex",
      }),
      generatedTemplateDraft: {
        ...currentDraft,
        name,
        language,
        category,
        components,
        status: nextStatus,
        metaTemplateId: result.id,
        error: undefined,
      },
    }),
  });
  if (!graphMutation.applied) {
    return NextResponse.json(
      {
        error: "Scenario changed while submitting the generated template",
        reason: graphMutation.reason,
      },
      { status: 409 }
    );
  }

  scenarioTemplateSubmitLogger.info("template_submitted", {
    workspaceId,
    scenarioId,
    nodeId,
    templateName: name,
    status: nextStatus,
  });
  return NextResponse.json({
    ok: true,
    templateId: result.id,
    status: nextStatus,
    scenarioUpdate: graphMutation.scenarioUpdate,
  });
}
