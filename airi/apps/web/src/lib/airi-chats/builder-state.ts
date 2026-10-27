import { sanitizeWhatsAppFlowConfig } from "@/lib/scenarios/whatsapp-flow-config";
import { createWhatsAppComponentSchema } from "@/lib/whatsapp/templates/component-schemas";
import {
  normalizeAiriWhatsAppTemplateDraft,
  type AiriWhatsAppTemplateDraft,
} from "@/lib/airi-chats/whatsapp-template-drafts";
import {
  WHATSAPP_FLOW_UI_LOCALE_IDS,
  type WhatsAppFlowConfig,
} from "@icecore/scenario-contracts";
import { z } from "zod";
import {
  draftArray,
  draftEnum,
  draftObject,
  draftString,
  type AiriDraftResponseSchema,
} from "@/lib/airi-chats/draft-output";

const whatsappComponentSchema = createWhatsAppComponentSchema(undefined, {
  requireFlowNavigateScreen: false,
  requireMediaHeaderExample: false,
});

export const airiBuilderTemplateDraftSchema = z.object({
  kind: z.literal("whatsapp_template").optional(),
  name: z.string().trim().min(1).max(512),
  language: z.string().trim().min(1).max(16),
  category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  components: z.array(whatsappComponentSchema).min(1).max(8),
  rationale: z.string().trim().max(240).optional(),
  missingDetails: z.array(z.string().trim().min(1).max(160)).max(5).optional(),
});

const flowOptionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(60),
});

const flowFieldSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
  fieldType: z.enum([
    "TextInput",
    "Dropdown",
    "DatePicker",
    "RadioButtonsGroup",
    "CheckboxGroup",
    "TextArea",
  ]),
  required: z.boolean().optional(),
  helperText: z.string().trim().max(120).optional(),
  options: z.array(flowOptionSchema).max(200).optional(),
});

const flowScreenSchema = z.object({
  id: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(80),
  fields: z.array(flowFieldSchema).min(1).max(50),
});

export const airiBuilderFlowConfigSchema = z.object({
  templateId: z.string().trim().max(80).optional().default("lead_generation"),
  screens: z.array(flowScreenSchema).min(1).max(20),
  ctaText: z.string().trim().max(35).optional().default("Open"),
  headerText: z.string().trim().max(60).optional(),
  bodyText: z.string().trim().max(1024).optional(),
  footerText: z.string().trim().max(60).optional(),
  flowUiLocale: z.enum(WHATSAPP_FLOW_UI_LOCALE_IDS).optional(),
  flowSubmitLabel: z.string().trim().max(35).optional(),
  flowNavigationMode: z.enum(["linear", "data_endpoint"]).optional(),
  screenRoutes: z
    .record(z.string(), z.array(z.string().trim().max(50)).max(20))
    .optional(),
  flowBranchRules: z
    .record(
      z.string(),
      z.record(z.string(), z.record(z.string(), z.string().trim().max(50)))
    )
    .optional(),
  metaFlowId: z.string().trim().max(128).nullable().optional(),
  metaFlowName: z.string().trim().max(128).nullable().optional(),
  metaFlowStatus: z.string().trim().max(40).nullable().optional(),
});

/**
 * responseSchema of the Flow draft call: the part of
 * airiBuilderFlowConfigSchema a model writes (same keys, enums from the same
 * schemas). Routes, branch rules and provider links are records or ids the
 * model cannot express; an edit keeps them from the open Flow
 * (mergeAiriDraftOverActive).
 */
export const AIRI_FLOW_DRAFT_RESPONSE_SCHEMA: AiriDraftResponseSchema =
  draftObject(
    {
      templateId: draftString("Flow template id, e.g. lead_generation"),
      ctaText: draftString("Button that opens the Flow, up to 35 characters"),
      headerText: draftString("Up to 60 characters"),
      bodyText: draftString("Message text, up to 1024 characters"),
      footerText: draftString("Up to 60 characters"),
      flowUiLocale: draftEnum(WHATSAPP_FLOW_UI_LOCALE_IDS),
      flowSubmitLabel: draftString("Submit button label, up to 35 characters"),
      screens: draftArray(
        draftObject({
          id: draftString(
            "Uppercase letters and underscores only, up to 50 characters"
          ),
          title: draftString("Up to 80 characters"),
          fields: draftArray(
            draftObject(
              {
                id: draftString("Concise field id, unique across the Flow"),
                label: draftString("Up to 80 characters"),
                fieldType: draftEnum(flowFieldSchema.shape.fieldType.options),
                required: { type: "BOOLEAN" },
                helperText: draftString("Up to 120 characters"),
                options: draftArray(
                  draftObject({
                    id: draftString(),
                    title: draftString("Up to 60 characters"),
                  }),
                  "Choice fields only (Dropdown, RadioButtonsGroup, CheckboxGroup): at least one option"
                ),
              },
              ["helperText", "options"]
            ),
            "1 or more fields"
          ),
        }),
        "1 to 20 screens"
      ),
    },
    ["headerText", "footerText", "flowSubmitLabel"]
  );

export const activeAiriBuilderSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("whatsapp_template"),
    artifactId: z.string().trim().min(1).max(128).optional(),
    revision: z.number().int().nonnegative().max(100_000),
    dirty: z.boolean().optional(),
    templateDraft: airiBuilderTemplateDraftSchema,
  }),
  z.object({
    kind: z.literal("whatsapp_flow"),
    artifactId: z.string().trim().min(1).max(128).optional(),
    revision: z.number().int().nonnegative().max(100_000),
    dirty: z.boolean().optional(),
    flowConfig: airiBuilderFlowConfigSchema,
  }),
]);

export const airiBuilderUiStateSchema = z.object({
  open: z.boolean().optional(),
  panelSize: z.number().min(24).max(48).optional(),
});

export const airiBuilderPatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("whatsapp_template"),
    baseRevision: z.number().int().nonnegative().max(100_000),
    nextRevision: z.number().int().nonnegative().max(100_001),
    summary: z.string().trim().min(1).max(240),
    snapshot: z.object({
      templateDraft: airiBuilderTemplateDraftSchema,
    }),
  }),
  z.object({
    kind: z.literal("whatsapp_flow"),
    baseRevision: z.number().int().nonnegative().max(100_000),
    nextRevision: z.number().int().nonnegative().max(100_001),
    summary: z.string().trim().min(1).max(240),
    snapshot: z.object({
      flowConfig: airiBuilderFlowConfigSchema,
    }),
  }),
]);

export type ActiveAiriBuilderInput =
  | {
      kind: "whatsapp_template";
      artifactId?: string;
      revision: number;
      dirty?: boolean;
      templateDraft: AiriWhatsAppTemplateDraft;
    }
  | {
      kind: "whatsapp_flow";
      artifactId?: string;
      revision: number;
      dirty?: boolean;
      flowConfig: WhatsAppFlowConfig;
    };

export type AiriBuilderUiState = {
  open: boolean;
  panelSize?: number;
};

export type AiriBuilderPatch =
  | {
      kind: "whatsapp_template";
      baseRevision: number;
      nextRevision: number;
      summary: string;
      snapshot: {
        templateDraft: AiriWhatsAppTemplateDraft;
      };
    }
  | {
      kind: "whatsapp_flow";
      baseRevision: number;
      nextRevision: number;
      summary: string;
      snapshot: {
        flowConfig: WhatsAppFlowConfig;
      };
    };

export function normalizeActiveAiriBuilder(
  value: unknown
): ActiveAiriBuilderInput | null {
  const parsed = activeAiriBuilderSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === "whatsapp_template") {
    const draft = normalizeAiriWhatsAppTemplateDraft(parsed.data.templateDraft);
    return draft
      ? {
          kind: "whatsapp_template",
          artifactId: parsed.data.artifactId || undefined,
          revision: parsed.data.revision,
          dirty: parsed.data.dirty || undefined,
          templateDraft: draft,
        }
      : null;
  }
  const flowConfig = sanitizeWhatsAppFlowConfig(parsed.data.flowConfig);
  return flowConfig
    ? {
        kind: "whatsapp_flow",
        artifactId: parsed.data.artifactId || undefined,
        revision: parsed.data.revision,
        dirty: parsed.data.dirty || undefined,
        flowConfig,
      }
    : null;
}

export function normalizeAiriBuilderUiState(
  value: unknown
): AiriBuilderUiState {
  const parsed = airiBuilderUiStateSchema.safeParse(value);
  if (!parsed.success) {
    return { open: false };
  }
  return {
    open: Boolean(parsed.data.open),
    panelSize: parsed.data.panelSize,
  };
}

export function normalizeAiriBuilderPatch(
  value: unknown
): AiriBuilderPatch | null {
  const parsed = airiBuilderPatchSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.kind === "whatsapp_template") {
    const draft = normalizeAiriWhatsAppTemplateDraft(
      parsed.data.snapshot.templateDraft
    );
    return draft
      ? {
          kind: "whatsapp_template",
          baseRevision: parsed.data.baseRevision,
          nextRevision: parsed.data.nextRevision,
          summary: parsed.data.summary,
          snapshot: { templateDraft: draft },
        }
      : null;
  }
  const flowConfig = sanitizeWhatsAppFlowConfig(
    parsed.data.snapshot.flowConfig
  );
  return flowConfig
    ? {
        kind: "whatsapp_flow",
        baseRevision: parsed.data.baseRevision,
        nextRevision: parsed.data.nextRevision,
        summary: parsed.data.summary,
        snapshot: { flowConfig },
      }
    : null;
}

export function createTemplateBuilderPatch(params: {
  baseRevision: number;
  draft: AiriWhatsAppTemplateDraft;
  summary?: string;
}): AiriBuilderPatch {
  return {
    kind: "whatsapp_template",
    baseRevision: params.baseRevision,
    nextRevision: params.baseRevision + 1,
    summary: params.summary || `Updated ${params.draft.name}`,
    snapshot: {
      templateDraft: params.draft,
    },
  };
}

export function createFlowBuilderPatch(params: {
  baseRevision: number;
  flowConfig: WhatsAppFlowConfig;
  summary?: string;
}): AiriBuilderPatch {
  return {
    kind: "whatsapp_flow",
    baseRevision: params.baseRevision,
    nextRevision: params.baseRevision + 1,
    summary: params.summary || "Updated WhatsApp Flow",
    snapshot: {
      flowConfig: params.flowConfig,
    },
  };
}
