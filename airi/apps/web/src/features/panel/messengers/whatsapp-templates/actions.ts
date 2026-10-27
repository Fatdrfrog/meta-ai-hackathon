"use server";

import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { WHATSAPP_TEMPLATE_MANAGER_ONLY as MANAGER_ONLY } from "@/lib/whatsapp/get-workspace-context";
import { WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY } from "@/lib/whatsapp/marketing/message-pricing";
import {
  createWhatsAppComponentSchema,
  parseWhatsAppTemplateSubmissionComponents,
} from "@/lib/whatsapp/templates/component-schemas";
import {
  deleteWhatsAppTemplateMutation,
  syncWhatsAppTemplatesMutation,
  updateWhatsAppTemplateMutation,
} from "@/lib/whatsapp/templates/mutation-service";
import { logTemplateAction } from "@/lib/whatsapp/templates/service";
import {
  WhatsAppTemplateCatalogError,
  type WhatsAppTemplateCatalogErrorCode,
} from "@/lib/whatsapp/templates/catalog-contracts";
import { createUnifiedTemplateRecord } from "@/lib/whatsapp/templates/unified-service";
import {
  SwitchUnifiedTemplateWabaError,
  switchUnifiedTemplateToCurrentWaba,
} from "@/lib/whatsapp/templates/switch-to-current-waba";
import { normalizeWhatsAppTemplateLanguageCode } from "@icecore/shared/constants/whatsapp-templates";
import type {
  WhatsAppComponent,
  WhatsAppTemplateCategory,
} from "@icecore/shared/types/whatsapp";
import type {
  TelegramTemplateData,
  TemplateChannel,
  UnifiedTemplate,
  WhatsAppTemplateData,
} from "@icecore/shared/types/templates";
import { revalidatePath } from "next/cache";
import { z } from "zod";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const WhatsAppComponentSchema = createWhatsAppComponentSchema(undefined, {
  allowAuthenticationFields: true,
});

function validateSubmissionComponents(
  data: {
    components?: WhatsAppComponent[];
    category?: WhatsAppTemplateCategory;
  },
  ctx: z.RefinementCtx
) {
  if (data.components === undefined) return;
  const parsed = parseWhatsAppTemplateSubmissionComponents(
    data.components,
    data.category
  );
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      ctx.addIssue({ ...issue, path: ["components", ...issue.path] });
  }
}

const WhatsAppTemplateLanguageSchema = z
  .string()
  .min(2)
  .max(10)
  .transform((value, ctx) => {
    const language = normalizeWhatsAppTemplateLanguageCode(value);
    if (!language) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported WhatsApp template language code: ${value}`,
      });
      return z.NEVER;
    }
    return language;
  });

const MarketingMessagesOptimizationSpecSchema = z.object({
  bid_amount: z.number().int().positive(),
  bid_strategy: z.literal(WHATSAPP_MARKETING_MESSAGES_BID_STRATEGY),
});

const UpdateTemplateSchema = z
  .object({
    workspaceId: z.string().uuid(),
    templateId: z.string().min(1),
    category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(),
    components: z.array(WhatsAppComponentSchema).optional(),
    allow_category_change: z.boolean().optional(),
    optimization_spec: MarketingMessagesOptimizationSpecSchema.optional(),
  })
  .superRefine((data, ctx) => {
    validateSubmissionComponents(data, ctx);
    if (
      data.optimization_spec &&
      data.category !== undefined &&
      data.category !== "MARKETING"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "optimization_spec is only supported for MARKETING templates",
        path: ["optimization_spec"],
      });
    }
  });

const DeleteTemplateSchema = z.object({
  workspaceId: z.string().uuid(),
  templateName: z.string().min(1),
  templateId: z.string().min(1).optional(),
  templateLanguage: WhatsAppTemplateLanguageSchema.optional(),
});

const SyncTemplatesSchema = z.object({
  workspaceId: z.string().uuid(),
});

// ============================================================================
// ACTION RESULTS
// ============================================================================

type ActionResult<T = unknown> =
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      code?: WhatsAppTemplateCatalogErrorCode;
      providerCode?: number;
      retryAt?: string | null;
    };

// ============================================================================
// HELPER: Verify workspace access and role
// ============================================================================

/**
 * Workspace admins and managers can read and mutate templates, matching the
 * /api/whatsapp/templates routes and their action-specific denial messages.
 */
async function verifyAccess(
  workspaceId: string,
  managerOnly?: (typeof MANAGER_ONLY)[keyof typeof MANAGER_ONLY]
): Promise<{ userId: string } | { error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized" };
  }

  const { data: membership, error: membershipError } = await supabase
    .from("company_users")
    .select("role")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (membershipError || !membership) {
    return { error: "Forbidden" };
  }

  if (!isWorkspaceManagerRole(membership.role)) {
    return { error: managerOnly ?? "Forbidden" };
  }

  return { userId: user.id };
}

// ============================================================================
// SERVER ACTIONS
// ============================================================================

export async function updateTemplateAction(
  input: unknown
): Promise<ActionResult<{ success: boolean; warning?: string }>> {
  try {
    const validated = UpdateTemplateSchema.parse(input);

    const access = await verifyAccess(
      validated.workspaceId,
      MANAGER_ONLY.update
    );
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const result = await updateWhatsAppTemplateMutation({
      workspaceId: validated.workspaceId,
      userId: access.userId,
      templateId: validated.templateId,
      category: validated.category,
      components: validated.components,
      allowCategoryChange: validated.allow_category_change,
      optimizationSpec: validated.optimization_spec,
    });

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function deleteTemplateAction(
  input: unknown
): Promise<ActionResult<{ success: boolean }>> {
  try {
    const validated = DeleteTemplateSchema.parse(input);

    const access = await verifyAccess(
      validated.workspaceId,
      MANAGER_ONLY.delete
    );
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const result = await deleteWhatsAppTemplateMutation({
      workspaceId: validated.workspaceId,
      userId: access.userId,
      templateName: validated.templateName,
      templateId: validated.templateId,
      templateLanguage: validated.templateLanguage,
    });

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function syncTemplatesAction(
  input: unknown
): Promise<
  ActionResult<Awaited<ReturnType<typeof syncWhatsAppTemplatesMutation>>>
> {
  try {
    const validated = SyncTemplatesSchema.parse(input);

    const access = await verifyAccess(validated.workspaceId);
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const result = await syncWhatsAppTemplatesMutation({
      workspaceId: validated.workspaceId,
      userId: access.userId,
    });

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return { success: true, data: result };
  } catch (error) {
    if (error instanceof WhatsAppTemplateCatalogError) {
      return {
        success: false,
        error: error.message,
        code: error.code,
        providerCode: error.providerCode,
        retryAt: error.retryAt,
      };
    }
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// ============================================================================
// UNIFIED TEMPLATE SCHEMAS
// ============================================================================

const TelegramButtonSchema = z.object({
  text: z.string().min(1).max(64),
  url: z.string().url().optional(),
  callbackData: z.string().max(64).optional(),
});

const TelegramDataSchema = z.object({
  text: z.string().min(1).max(4096),
  parseMode: z.enum(["Markdown", "HTML"]).optional(),
  inlineKeyboard: z.array(z.array(TelegramButtonSchema)).optional(),
});

const WhatsAppDataSchema = z
  .object({
    language: WhatsAppTemplateLanguageSchema,
    category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
    components: z.array(WhatsAppComponentSchema).min(1),
    allow_category_change: z.boolean().optional(),
    optimization_spec: MarketingMessagesOptimizationSpecSchema.optional(),
  })
  .superRefine((data, ctx) => {
    validateSubmissionComponents(data, ctx);
    if (data.optimization_spec && data.category !== "MARKETING") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "optimization_spec is only supported for MARKETING templates",
        path: ["optimization_spec"],
      });
    }
  });

const CreateUnifiedTemplateSchema = z
  .object({
    workspaceId: z.string().uuid(),
    name: z
      .string()
      .min(1)
      .max(512)
      .regex(
        /^[a-z0-9_]+$/,
        "Name must be lowercase alphanumeric with underscores"
      ),
    channel: z.enum(["whatsapp", "telegram", "both"]),
    whatsappData: WhatsAppDataSchema.optional(),
    telegramData: TelegramDataSchema.optional(),
  })
  .refine(
    data => {
      if (data.channel === "whatsapp" || data.channel === "both") {
        return data.whatsappData !== undefined;
      }
      return true;
    },
    { message: "WhatsApp data required for whatsapp/both channel" }
  )
  .refine(
    data => {
      if (data.channel === "telegram" || data.channel === "both") {
        return data.telegramData !== undefined;
      }
      return true;
    },
    { message: "Telegram data required for telegram/both channel" }
  );

const UpdateUnifiedTemplateSchema = z.object({
  workspaceId: z.string().uuid(),
  templateId: z.string().uuid(),
  channel: z.enum(["whatsapp", "telegram", "both"]).optional(),
  whatsappData: WhatsAppDataSchema.optional(),
  telegramData: TelegramDataSchema.optional(),
});

const GetUnifiedTemplatesSchema = z.object({
  workspaceId: z.string().uuid(),
  channel: z.enum(["whatsapp", "telegram", "both"]).optional(),
});

const DeleteUnifiedTemplateSchema = z.object({
  workspaceId: z.string().uuid(),
  templateId: z.string().uuid(),
  metaTemplateId: z.string().min(1).optional(),
  templateName: z.string().min(1).optional(),
  templateLanguage: WhatsAppTemplateLanguageSchema.optional(),
});

const SwitchUnifiedTemplateWabaSchema = z.object({
  workspaceId: z.string().uuid(),
  templateId: z.string().uuid(),
});

// ============================================================================
// UNIFIED TEMPLATE ACTIONS
// ============================================================================

/**
 * Create a unified template (supports WhatsApp, Telegram, or both)
 */
export async function createUnifiedTemplateAction(
  input: unknown
): Promise<ActionResult<{ id: string; warning?: string }>> {
  try {
    const validated = CreateUnifiedTemplateSchema.parse(input);

    const access = await verifyAccess(
      validated.workspaceId,
      MANAGER_ONLY.create
    );
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const supabase = await createClient();
    const template = await createUnifiedTemplateRecord({
      supabase,
      workspaceId: validated.workspaceId,
      userId: access.userId,
      name: validated.name,
      channel: validated.channel,
      whatsappData: validated.whatsappData,
      telegramData: validated.telegramData,
      analyticsOrigin: "templates_page",
    });

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return {
      success: true,
      data: {
        id: template.id,
        warning: template.warning,
      },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Update a unified template
 */
export async function updateUnifiedTemplateAction(
  input: unknown
): Promise<ActionResult<{ success: boolean }>> {
  try {
    const validated = UpdateUnifiedTemplateSchema.parse(input);

    const access = await verifyAccess(
      validated.workspaceId,
      MANAGER_ONLY.update
    );
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const supabase = await createClient();

    // Build update payload
    const updatePayload: Record<string, unknown> = {};
    if (validated.channel) updatePayload.channel = validated.channel;
    if (validated.whatsappData) {
      const { data: existing } = await supabase
        .from("message_templates")
        .select("whatsapp_data")
        .eq("id", validated.templateId)
        .eq("workspace_id", validated.workspaceId)
        .maybeSingle();

      const existingWhatsAppData =
        existing?.whatsapp_data as WhatsAppTemplateData | null;

      updatePayload.whatsapp_data = {
        ...validated.whatsappData,
        metaTemplateId: existingWhatsAppData?.metaTemplateId,
        status: existingWhatsAppData?.status,
        wabaId: existingWhatsAppData?.wabaId,
      };
    }
    if (validated.telegramData)
      updatePayload.telegram_data = validated.telegramData;

    const { error: updateError } = await supabase
      .from("message_templates")
      .update(updatePayload)
      .eq("id", validated.templateId)
      .eq("workspace_id", validated.workspaceId);

    if (updateError) {
      return {
        success: false,
        error: `Database error: ${updateError.message}`,
      };
    }

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return { success: true, data: { success: true } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export async function switchUnifiedTemplateToCurrentWabaAction(
  input: unknown
): Promise<
  ActionResult<{
    metaTemplateId: string;
    status: string;
    wabaId: string;
    warning?: string;
  }>
> {
  try {
    const validated = SwitchUnifiedTemplateWabaSchema.parse(input);

    const access = await verifyAccess(
      validated.workspaceId,
      MANAGER_ONLY.create
    );
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const supabase = await createClient();
    const result = await switchUnifiedTemplateToCurrentWaba({
      supabase,
      workspaceId: validated.workspaceId,
      userId: access.userId,
      templateId: validated.templateId,
    });

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error:
        error instanceof SwitchUnifiedTemplateWabaError ||
        error instanceof Error
          ? error.message
          : "Unknown error",
    };
  }
}

/**
 * Get unified templates for a workspace
 */
export async function getUnifiedTemplatesAction(
  input: unknown
): Promise<ActionResult<{ templates: UnifiedTemplate[] }>> {
  try {
    const validated = GetUnifiedTemplatesSchema.parse(input);

    const access = await verifyAccess(validated.workspaceId);
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const supabase = await createClient();

    let query = supabase
      .from("message_templates")
      .select(
        "id, workspace_id, name, channel, whatsapp_data, telegram_data, created_at, updated_at"
      )
      .eq("workspace_id", validated.workspaceId)
      .order("created_at", { ascending: false });

    if (validated.channel) {
      // Filter by channel, including 'both' when filtering
      if (validated.channel === "whatsapp") {
        query = query.in("channel", ["whatsapp", "both"]);
      } else if (validated.channel === "telegram") {
        query = query.in("channel", ["telegram", "both"]);
      } else {
        query = query.eq("channel", validated.channel);
      }
    }

    const { data: templates, error: fetchError } = await query;

    if (fetchError) {
      return {
        success: false,
        error: `Database error: ${fetchError.message}`,
      };
    }

    // Map to UnifiedTemplate type
    const mappedTemplates: UnifiedTemplate[] = (templates || []).map(t => ({
      id: t.id,
      workspace_id: t.workspace_id,
      name: t.name,
      channel: t.channel as TemplateChannel,
      whatsapp_data: t.whatsapp_data as WhatsAppTemplateData | undefined,
      telegram_data: t.telegram_data as TelegramTemplateData | undefined,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    return {
      success: true,
      data: { templates: mappedTemplates },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Delete a unified template
 */
export async function deleteUnifiedTemplateAction(
  input: unknown
): Promise<ActionResult<{ success: boolean }>> {
  try {
    const validated = DeleteUnifiedTemplateSchema.parse(input);

    const access = await verifyAccess(
      validated.workspaceId,
      MANAGER_ONLY.delete
    );
    if ("error" in access) {
      return { success: false, error: access.error };
    }

    const supabase = await createClient();

    // Get template first to check if it has WhatsApp data
    const { data: existingTemplate } = await supabase
      .from("message_templates")
      .select("name, channel, whatsapp_data")
      .eq("id", validated.templateId)
      .eq("workspace_id", validated.workspaceId)
      .single();

    // Delete from unified table
    const { error: deleteError } = await supabase
      .from("message_templates")
      .delete()
      .eq("id", validated.templateId)
      .eq("workspace_id", validated.workspaceId);

    if (deleteError) {
      return {
        success: false,
        error: `Database error: ${deleteError.message}`,
      };
    }

    // If WhatsApp template, also delete from Meta API
    if (
      existingTemplate &&
      (existingTemplate.channel === "whatsapp" ||
        existingTemplate.channel === "both") &&
      existingTemplate.whatsapp_data
    ) {
      const whatsappData =
        existingTemplate.whatsapp_data as WhatsAppTemplateData | null;
      const metaTemplateName =
        validated.templateName || existingTemplate.name || "";
      const metaTemplateId =
        validated.metaTemplateId || whatsappData?.metaTemplateId;
      const metaTemplateLanguage =
        validated.templateLanguage || whatsappData?.language;

      if (metaTemplateName) {
        // Delete from Meta API - if it fails, we still consider success since DB is clean
        await deleteWhatsAppTemplateMutation({
          workspaceId: validated.workspaceId,
          userId: access.userId,
          templateName: metaTemplateName,
          templateId: metaTemplateId,
          templateLanguage: metaTemplateLanguage,
          audit: { enabled: false },
        }).catch(() => {});
      }
    }

    // Log action
    await logTemplateAction(
      validated.workspaceId,
      access.userId,
      "DELETE",
      existingTemplate?.name || validated.templateId
    ).catch(() => {});

    revalidatePath(
      `/panel/w/${validated.workspaceId}/messengers/whatsapp-templates`
    );

    return { success: true, data: { success: true } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: error.errors
          .map(e => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
