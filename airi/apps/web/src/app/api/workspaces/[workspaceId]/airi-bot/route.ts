import {
  setWorkspaceBotDefault,
  setWorkspaceScenariosDefault,
  setWorkspaceCoachDefault,
  getWorkspaceBotRuntimeSettings,
  updateWorkspaceBotRuntimeSettings,
} from "@/lib/airi/workspace-bot-default";
import type {
  WorkspaceBotRuntimeSettings,
  WorkspaceBotSettingsApiResponse,
} from "@/lib/airi/workspace-bot-contract";
import { WorkspaceBotRuntimeSettingsPatchSchema } from "@/lib/airi/workspace-bot-schema";
import { resolveWorkspaceVoiceReplyAccess } from "@/lib/airi/voice-reply-access";
import connectDB from "@/lib/mongoose";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";

type Params = Promise<{ workspaceId: string }>;

const enabledConversationsQuery = (workspaceId: string) => ({
  workspaceId,
  $or: [
    { airi_bot_enabled: true },
    { airi_bot_enabled: { $exists: false }, airi_enabled: true },
    { airi_bot_enabled: null, airi_enabled: true },
  ],
});

/** Matches runtime `airi_coach_enabled ?? airi_enabled ?? true` (see coach job / API). */
const coachEffectivelyEnabledQuery = (workspaceId: string) => ({
  workspaceId,
  $or: [
    { airi_coach_enabled: true },
    {
      $and: [
        {
          $or: [
            { airi_coach_enabled: { $exists: false } },
            { airi_coach_enabled: null },
          ],
        },
        {
          $or: [
            { airi_enabled: { $exists: false } },
            { airi_enabled: null },
            { airi_enabled: true },
          ],
        },
      ],
    },
  ],
});

const scenariosEnabledConversationsQuery = (
  workspaceId: string,
  workspaceScenariosDefaultEnabled: boolean
) => {
  const fallbackConditions: Record<string, unknown>[] = [
    { airi_bot_enabled: true },
    { airi_bot_enabled: { $exists: false }, airi_enabled: true },
    { airi_bot_enabled: null, airi_enabled: true },
  ];

  if (workspaceScenariosDefaultEnabled) {
    fallbackConditions.push({
      $and: [
        {
          $or: [
            { airi_bot_enabled: { $exists: false } },
            { airi_bot_enabled: null },
          ],
        },
        {
          $or: [{ airi_enabled: { $exists: false } }, { airi_enabled: null }],
        },
      ],
    });
  }

  return {
    workspaceId,
    $or: [
      { airi_scenarios_enabled: true },
      {
        $and: [
          {
            $or: [
              { airi_scenarios_enabled: { $exists: false } },
              { airi_scenarios_enabled: null },
            ],
          },
          { $or: fallbackConditions },
        ],
      },
    ],
  };
};

function conditionalFieldValue(params: {
  condition: Record<string, unknown>;
  clearedValue: unknown;
  fieldName: string;
}): Record<string, unknown> {
  return {
    $cond: [params.condition, params.clearedValue, `$${params.fieldName}`],
  };
}

export function buildExistingConversationBotRolloutUpdate(params: {
  enabled: boolean;
  assignedBy: string;
  scenarioDefaultForUnsetConversations: boolean;
}): Record<string, unknown>[] {
  const activeHandoffCondition = { $eq: ["$airi_handoff_active", true] };
  const activeScenarioHandoffSuppressionCondition = {
    $and: [
      activeHandoffCondition,
      { $eq: ["$airi_last_suppressed_reason", "scenario_handoff"] },
    ],
  };
  const setPayload: Record<string, unknown> = {
    airi_scenarios_enabled: {
      $cond: [
        { $eq: [{ $type: "$airi_scenarios_enabled" }, "bool"] },
        "$airi_scenarios_enabled",
        {
          $ifNull: [
            "$airi_bot_enabled",
            {
              $ifNull: [
                "$airi_enabled",
                params.scenarioDefaultForUnsetConversations,
              ],
            },
          ],
        },
      ],
    },
    airi_bot_enabled: params.enabled,
    airi_assigned_by: params.assignedBy,
  };

  if (params.enabled) {
    Object.assign(setPayload, {
      airi_handoff_active: false,
      airi_handoff_started_at: conditionalFieldValue({
        condition: activeHandoffCondition,
        clearedValue: null,
        fieldName: "airi_handoff_started_at",
      }),
      airi_handoff_source: conditionalFieldValue({
        condition: activeHandoffCondition,
        clearedValue: null,
        fieldName: "airi_handoff_source",
      }),
      airi_handoff_reason: conditionalFieldValue({
        condition: activeHandoffCondition,
        clearedValue: null,
        fieldName: "airi_handoff_reason",
      }),
      airi_handoff_restore_bot_enabled: conditionalFieldValue({
        condition: activeHandoffCondition,
        clearedValue: null,
        fieldName: "airi_handoff_restore_bot_enabled",
      }),
      airi_last_suppressed_at: conditionalFieldValue({
        condition: activeScenarioHandoffSuppressionCondition,
        clearedValue: null,
        fieldName: "airi_last_suppressed_at",
      }),
      airi_last_suppressed_reason: conditionalFieldValue({
        condition: activeScenarioHandoffSuppressionCondition,
        clearedValue: null,
        fieldName: "airi_last_suppressed_reason",
      }),
      airi_last_suppressed_manager_user_id: conditionalFieldValue({
        condition: activeScenarioHandoffSuppressionCondition,
        clearedValue: null,
        fieldName: "airi_last_suppressed_manager_user_id",
      }),
      airi_last_suppressed_message_id: conditionalFieldValue({
        condition: activeScenarioHandoffSuppressionCondition,
        clearedValue: null,
        fieldName: "airi_last_suppressed_message_id",
      }),
      status: conditionalFieldValue({
        condition: activeHandoffCondition,
        clearedValue: "open",
        fieldName: "status",
      }),
    });
  }

  return [{ $set: setPayload }];
}

function buildWorkspaceBotSettingsResponse(params: {
  runtimeSettings: WorkspaceBotRuntimeSettings;
  totalConversations: number;
  enabledConversations: number;
  scenariosEnabledConversations: number;
  coachEnabledConversations: number;
  publishedKbArticlesCount?: number;
  shouldShowOnboardingHint?: boolean;
  voiceReplyAccess?: WorkspaceBotSettingsApiResponse["voiceReplyAccess"];
}): WorkspaceBotSettingsApiResponse {
  return {
    success: true,
    defaultBotEnabled: params.runtimeSettings.defaultBotEnabled,
    defaultScenariosEnabled: params.runtimeSettings.defaultScenariosEnabled,
    defaultCoachEnabled: params.runtimeSettings.defaultCoachEnabled,
    retrievalQueryMode: params.runtimeSettings.retrievalQueryMode,
    includeRecentConversationInRetrievalContext:
      params.runtimeSettings.includeRecentConversationInRetrievalContext,
    sendKbArticleLinksToUserChannels:
      params.runtimeSettings.sendKbArticleLinksToUserChannels,
    elevenlabsAgentId: params.runtimeSettings.elevenlabsAgentId,
    whatsappVoiceRepliesEnabled:
      params.runtimeSettings.whatsappVoiceRepliesEnabled === true,
    voiceReplyAccess: params.voiceReplyAccess,
    languageBias: params.runtimeSettings.languageBias,
    agentPersona: params.runtimeSettings.agentPersona,
    customInstructions: params.runtimeSettings.customInstructions,
    greetingBehavior: params.runtimeSettings.greetingBehavior,
    escalationBehavior: params.runtimeSettings.escalationBehavior,
    responseStyle: params.runtimeSettings.responseStyle,
    customAvailableActions: params.runtimeSettings.customAvailableActions,
    channelInstructions: params.runtimeSettings.channelInstructions,
    totalConversations: params.totalConversations,
    enabledConversations: params.enabledConversations,
    scenariosEnabledConversations: params.scenariosEnabledConversations,
    coachEnabledConversations: params.coachEnabledConversations,
    publishedKbArticlesCount: params.publishedKbArticlesCount,
    shouldShowOnboardingHint: params.shouldShowOnboardingHint,
  };
}

export const UpdateAiriBotSchema = z
  .object({
    enabled: z.boolean().optional(),
    applyToExisting: z.boolean().optional(),
    scenariosEnabled: z.boolean().optional(),
    applyScenariosToExisting: z.boolean().optional(),
    coachEnabled: z.boolean().optional(),
    applyCoachToExisting: z.boolean().optional(),
  })
  .merge(WorkspaceBotRuntimeSettingsPatchSchema)
  .refine(
    data => {
      const hasBotPair =
        data.enabled !== undefined && data.applyToExisting !== undefined;
      const hasCoachPair =
        data.coachEnabled !== undefined &&
        data.applyCoachToExisting !== undefined;
      const hasScenariosPair =
        data.scenariosEnabled !== undefined &&
        data.applyScenariosToExisting !== undefined;
      const hasRuntimePatch =
        data.retrievalQueryMode !== undefined ||
        data.includeRecentConversationInRetrievalContext !== undefined ||
        data.sendKbArticleLinksToUserChannels !== undefined ||
        data.elevenlabsAgentId !== undefined ||
        data.whatsappVoiceRepliesEnabled !== undefined ||
        data.languageBias !== undefined ||
        data.agentPersona !== undefined ||
        data.customInstructions !== undefined ||
        data.greetingBehavior !== undefined ||
        data.escalationBehavior !== undefined ||
        data.responseStyle !== undefined ||
        data.customAvailableActions !== undefined ||
        data.channelInstructions !== undefined;
      return hasBotPair || hasScenariosPair || hasCoachPair || hasRuntimePatch;
    },
    {
      message:
        "Provide enabled+applyToExisting and/or scenariosEnabled+applyScenariosToExisting and/or coachEnabled+applyCoachToExisting and/or runtime settings",
    }
  );

export async function GET(
  _request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Workspace not found or unauthorized" },
        { status: 404 }
      );
    }

    await connectDB();

    const [runtimeSettings, voiceReplyAccess] = await Promise.all([
      getWorkspaceBotRuntimeSettings(workspaceId),
      resolveWorkspaceVoiceReplyAccess({ workspaceId, supabase }),
    ]);
    const [
      totalConversations,
      enabledConversations,
      scenariosEnabledConversations,
      coachEnabledConversations,
      publishedKbArticlesCount,
    ] = await Promise.all([
      Conversation.countDocuments({ workspaceId }),
      Conversation.countDocuments(enabledConversationsQuery(workspaceId)),
      Conversation.countDocuments(
        scenariosEnabledConversationsQuery(
          workspaceId,
          runtimeSettings.defaultScenariosEnabled
        )
      ),
      Conversation.countDocuments(coachEffectivelyEnabledQuery(workspaceId)),
      (async () => {
        const { count } = await supabase
          .from("kb_articles")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId)
          .eq("status", "published");
        return count ?? 0;
      })(),
    ]);

    return NextResponse.json(
      buildWorkspaceBotSettingsResponse({
        runtimeSettings,
        voiceReplyAccess: {
          available: voiceReplyAccess.available,
          reason: voiceReplyAccess.reason,
        },
        totalConversations,
        enabledConversations,
        scenariosEnabledConversations,
        coachEnabledConversations,
        publishedKbArticlesCount,
        shouldShowOnboardingHint:
          publishedKbArticlesCount > 0 && !runtimeSettings.defaultBotEnabled,
      })
    );
  } catch (error) {
    console.error("[Workspace Airi Bot GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch Airi bot settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Params }
) {
  try {
    const { workspaceId } = await params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json(
        { error: "Workspace not found or unauthorized" },
        { status: 404 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = UpdateAiriBotSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "Invalid body: send enabled+applyToExisting, scenariosEnabled+applyScenariosToExisting, coachEnabled+applyCoachToExisting, or runtime settings",
        },
        { status: 400 }
      );
    }
    const {
      enabled,
      applyToExisting,
      scenariosEnabled,
      applyScenariosToExisting,
      coachEnabled,
      applyCoachToExisting,
      retrievalQueryMode,
      includeRecentConversationInRetrievalContext,
      sendKbArticleLinksToUserChannels,
      elevenlabsAgentId,
      whatsappVoiceRepliesEnabled,
      languageBias,
      agentPersona,
      customInstructions,
      greetingBehavior,
      escalationBehavior,
      responseStyle,
      customAvailableActions,
      channelInstructions,
    } = parsed.data;

    let voiceReplyAccess: WorkspaceBotSettingsApiResponse["voiceReplyAccess"];
    if (whatsappVoiceRepliesEnabled === true) {
      const access = await resolveWorkspaceVoiceReplyAccess({
        workspaceId,
        supabase,
      });
      voiceReplyAccess = { available: access.available, reason: access.reason };
      if (!access.available) {
        return NextResponse.json(
          {
            error:
              access.reason === "subscription_required"
                ? "WhatsApp voice replies require a Pro or Enterprise plan"
                : "Connect an ElevenLabs account to enable WhatsApp voice replies",
            voiceReplyAccess,
          },
          { status: access.reason === "subscription_required" ? 402 : 400 }
        );
      }
    } else {
      // Availability refresh must never prevent an opt-out or unrelated settings save.
      try {
        const access = await resolveWorkspaceVoiceReplyAccess({
          workspaceId,
          supabase,
        });
        voiceReplyAccess = {
          available: access.available,
          reason: access.reason,
        };
      } catch {
        voiceReplyAccess = undefined;
      }
    }

    await connectDB();

    if (enabled !== undefined && applyToExisting !== undefined) {
      await setWorkspaceBotDefault(workspaceId, enabled, user.id);
      if (applyToExisting) {
        const scenarioDefaultForUnsetConversations = (
          await getWorkspaceBotRuntimeSettings(workspaceId)
        ).defaultScenariosEnabled;
        await Conversation.updateMany(
          { workspaceId },
          buildExistingConversationBotRolloutUpdate({
            enabled,
            assignedBy: user.id,
            scenarioDefaultForUnsetConversations,
          })
        );
      }
    }

    if (
      scenariosEnabled !== undefined &&
      applyScenariosToExisting !== undefined
    ) {
      await setWorkspaceScenariosDefault(
        workspaceId,
        scenariosEnabled,
        user.id
      );
      if (applyScenariosToExisting) {
        await Conversation.updateMany(
          { workspaceId },
          {
            $set: {
              airi_scenarios_enabled: scenariosEnabled,
              airi_assigned_by: user.id,
            },
          }
        );
      }
    }

    if (coachEnabled !== undefined && applyCoachToExisting !== undefined) {
      await setWorkspaceCoachDefault(workspaceId, coachEnabled, user.id);
      if (applyCoachToExisting) {
        await Conversation.updateMany(
          { workspaceId },
          {
            $set: {
              airi_coach_enabled: coachEnabled,
              airi_assigned_by: user.id,
            },
          }
        );
      }
    }

    const hasRuntimeUpdates =
      retrievalQueryMode !== undefined ||
      includeRecentConversationInRetrievalContext !== undefined ||
      sendKbArticleLinksToUserChannels !== undefined ||
      elevenlabsAgentId !== undefined ||
      whatsappVoiceRepliesEnabled !== undefined ||
      languageBias !== undefined ||
      agentPersona !== undefined ||
      customInstructions !== undefined ||
      greetingBehavior !== undefined ||
      escalationBehavior !== undefined ||
      responseStyle !== undefined ||
      customAvailableActions !== undefined ||
      channelInstructions !== undefined;

    const runtimeSettings = hasRuntimeUpdates
      ? await updateWorkspaceBotRuntimeSettings(
          workspaceId,
          {
            ...(retrievalQueryMode !== undefined ? { retrievalQueryMode } : {}),
            ...(includeRecentConversationInRetrievalContext !== undefined
              ? { includeRecentConversationInRetrievalContext }
              : {}),
            ...(sendKbArticleLinksToUserChannels !== undefined
              ? { sendKbArticleLinksToUserChannels }
              : {}),
            ...(elevenlabsAgentId !== undefined ? { elevenlabsAgentId } : {}),
            ...(whatsappVoiceRepliesEnabled !== undefined
              ? { whatsappVoiceRepliesEnabled }
              : {}),
            ...(languageBias !== undefined ? { languageBias } : {}),
            ...(agentPersona !== undefined ? { agentPersona } : {}),
            ...(customInstructions !== undefined ? { customInstructions } : {}),
            ...(greetingBehavior !== undefined ? { greetingBehavior } : {}),
            ...(escalationBehavior !== undefined ? { escalationBehavior } : {}),
            ...(responseStyle !== undefined ? { responseStyle } : {}),
            ...(customAvailableActions !== undefined
              ? { customAvailableActions }
              : {}),
            ...(channelInstructions !== undefined
              ? { channelInstructions }
              : {}),
          },
          user.id
        )
      : await getWorkspaceBotRuntimeSettings(workspaceId);

    const [
      totalConversations,
      enabledConversations,
      scenariosEnabledConversations,
      coachEnabledConversations,
    ] = await Promise.all([
      Conversation.countDocuments({ workspaceId }),
      Conversation.countDocuments(enabledConversationsQuery(workspaceId)),
      Conversation.countDocuments(
        scenariosEnabledConversationsQuery(
          workspaceId,
          runtimeSettings.defaultScenariosEnabled
        )
      ),
      Conversation.countDocuments(coachEffectivelyEnabledQuery(workspaceId)),
    ]);

    return NextResponse.json(
      buildWorkspaceBotSettingsResponse({
        runtimeSettings,
        voiceReplyAccess,
        totalConversations,
        enabledConversations,
        scenariosEnabledConversations,
        coachEnabledConversations,
      })
    );
  } catch (error) {
    console.error("[Workspace Airi Bot PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update Airi bot settings" },
      { status: 500 }
    );
  }
}
