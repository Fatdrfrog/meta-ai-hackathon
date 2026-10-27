/**
 * The per-intent dispatch table of an Airi chat turn. Adding an intent is a
 * new handler file plus one row here; the engine itself does not change.
 */

import type { AiriChatIntentKind } from "@/lib/airi-chats/intent-classifier";
import { shouldRerouteEmptyTenantToProductKb } from "@/lib/airi-chats/platform-how-to";
import type {
  GeneratedAiriChatReply,
  AiriTurnContext,
  AiriTurnHandler,
} from "../types";
import { hasAiriChatSearchContext } from "../retrieval";
import { handleProductCapabilityTurn } from "./product";
import { handleWhatsAppTemplateTurn } from "./whatsapp-template";
import { handleWhatsAppFlowTurn } from "./whatsapp-flow";
import { handleImageGenerationTurn } from "./image";
import { handleOpportunityScanTurn } from "./opportunity-scan";
import { handleMarketingCampaignTurn } from "./marketing-campaign";
import { handleMetaAdsTurn } from "./meta-ads";
import { handleGeneralAnswerTurn } from "./general";

export const AIRI_TURN_HANDLERS: Record<AiriChatIntentKind, AiriTurnHandler> = {
  general_answer: handleGeneralAnswerTurn,
  product_capability: context => handleProductCapabilityTurn(context),
  whatsapp_template: handleWhatsAppTemplateTurn,
  whatsapp_flow: handleWhatsAppFlowTurn,
  opportunity_scan: handleOpportunityScanTurn,
  marketing_campaign: handleMarketingCampaignTurn,
  image_generation: handleImageGenerationTurn,
  meta_ads_mcp: handleMetaAdsTurn,
};

/**
 * Runs the classified intent's handler. Meta Ads and product questions run
 * as classified; any other intent on an empty tenant that reads like a
 * platform how-to is answered from the published airi.chat KB instead.
 */
export function dispatchAiriTurn(
  context: AiriTurnContext
): Promise<GeneratedAiriChatReply> {
  const { intent } = context.intentClassification;
  if (
    intent !== "meta_ads_mcp" &&
    intent !== "product_capability" &&
    shouldRerouteEmptyTenantToProductKb({
      intent,
      userMessage: context.params.userMessage,
      // Context that could not load in time is not proof of an empty tenant.
      tenantHasKbOrChats:
        hasAiriChatSearchContext(context.searchResult) ||
        context.workspaceRetrieval.unavailable,
      hasSelectedSources: context.normalizedSelectedSources.length > 0,
    })
  ) {
    return handleProductCapabilityTurn(context, {
      fromIntent: intent,
      reason: "empty_tenant_platform_safety_net",
    });
  }
  const handler = AIRI_TURN_HANDLERS[intent] ?? handleGeneralAnswerTurn;
  return handler(context);
}
