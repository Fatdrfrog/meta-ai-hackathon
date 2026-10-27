import { readDefaultExport } from "@icecore/airi-runtime/module-interop";
import * as WorkspaceBotDefaults from "@/lib/airi/workspace-bot-default";
import * as CompanyLimits from "@/lib/limits/company-limits";
import * as SupabaseAdmin from "@/lib/supabase/admin";
import {
  createWhatsAppConversationOwnership,
  type WhatsAppConversationOwnershipModel,
} from "@icecore/airi-runtime/whatsapp-conversation-ownership";
import * as ChatModule from "@/models/chat";
import * as ConversationModel from "@/models/conversation";
import * as UserModule from "@/models/user";
import * as WhatsAppCallSessionModule from "@/models/whatsapp-call-session";
import { buildWhatsAppIdentitySnapshot } from "@icecore/shared/lib/whatsapp/identity-snapshot";
import type { WhatsAppIntakeCompanyPlan } from "@icecore/airi-runtime/whatsapp-intake-plan-gate";

import {
  createWhatsAppCallConversationLinker,
  type WhatsAppCallConversationLinkerDependencies,
  type WhatsAppCallConversationLinkResult,
} from "./whatsapp-call-conversation-linker-core.js";

export {
  createWhatsAppCallConversationLinker,
  type WhatsAppCallConversationLinkerDependencies,
  type WhatsAppCallConversationLinkResult,
};

function getModuleExport<T>(moduleNamespace: unknown, key: string): T {
  const module = moduleNamespace as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const value = module[key] ?? module.default?.[key];
  if (value === undefined) {
    throw new Error(`Module export not found: ${key}`);
  }
  return value as T;
}

const getWorkspaceBotDefault = getModuleExport<
  typeof WorkspaceBotDefaults.getWorkspaceBotDefault
>(WorkspaceBotDefaults, "getWorkspaceBotDefault");
const getWorkspaceCoachDefault = getModuleExport<
  typeof WorkspaceBotDefaults.getWorkspaceCoachDefault
>(WorkspaceBotDefaults, "getWorkspaceCoachDefault");
const getWorkspaceScenariosDefault = getModuleExport<
  typeof WorkspaceBotDefaults.getWorkspaceScenariosDefault
>(WorkspaceBotDefaults, "getWorkspaceScenariosDefault");
const ensureCompanyConversationCapacity = getModuleExport<
  typeof CompanyLimits.ensureCompanyConversationCapacity
>(CompanyLimits, "ensureCompanyConversationCapacity");
const supabaseAdmin = getModuleExport<typeof SupabaseAdmin.supabaseAdmin>(
  SupabaseAdmin,
  "supabaseAdmin",
);

/**
 * Plan read for the WhatsApp intake gate, bound here because this module
 * already owns the worker's company-limits import. One snapshot read answers
 * both questions: the trial lock and whether a new conversation is allowed.
 * Errors propagate; the gate fails open on them.
 */
export async function readWhatsAppIntakeCompanyPlan(
  workspaceId: string,
): Promise<WhatsAppIntakeCompanyPlan> {
  const capacity = await ensureCompanyConversationCapacity(
    supabaseAdmin,
    workspaceId,
  );
  return {
    trialExpired: capacity.limit.trialExpired === true,
    newConversationsAllowed: capacity.allowed,
  };
}
type ConversationModelLike = WhatsAppCallConversationLinkerDependencies<
  typeof supabaseAdmin
>["conversationModel"] &
  WhatsAppConversationOwnershipModel;

function resolveConversationModel(): ConversationModelLike {
  const module = ConversationModel as unknown as {
    Conversation?: ConversationModelLike;
    default?: { Conversation?: ConversationModelLike };
  };
  const model = module.Conversation ?? module.default?.Conversation;
  if (!model) {
    throw new Error("Conversation model export not found");
  }
  return model;
}

const conversationModel = resolveConversationModel();
const Chat = readDefaultExport<typeof ChatModule.default>(ChatModule);
const User = readDefaultExport<typeof UserModule.default>(UserModule);
const WhatsAppCallSession = readDefaultExport<
  typeof WhatsAppCallSessionModule.default
>(WhatsAppCallSessionModule);
const { getOrCreateWhatsAppConversation: getOrCreateConversation } =
  createWhatsAppConversationOwnership(conversationModel);

export const linkWhatsAppCallSessionToConversation =
  createWhatsAppCallConversationLinker({
    buildWhatsAppIdentitySnapshot,
    chatModel: Chat,
    conversationModel,
    getOrCreateConversation,
    ensureCompanyConversationCapacity,
    getWorkspaceBotDefault,
    getWorkspaceCoachDefault,
    getWorkspaceScenariosDefault,
    supabaseAdmin,
    userModel: User,
    whatsAppCallSessionModel: WhatsAppCallSession,
  } satisfies WhatsAppCallConversationLinkerDependencies<typeof supabaseAdmin>);
