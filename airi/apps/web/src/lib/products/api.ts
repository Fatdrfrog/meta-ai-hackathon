import "server-only";
import { noStoreJson } from "@/lib/http/no-store-json";
import { resolveProductsAccess } from "@/lib/products/access";
import type {
  ProductsErrorBody,
  ProductsErrorCode,
} from "@/lib/products/types";

// What every Products API route shares: its gate and its answers.

const ERROR_MESSAGES: Record<ProductsErrorCode, string> = {
  feature_disabled: "Feature disabled",
  admin_required: "Workspace admin access required",
  load_failed: "Products could not be loaded",
  invalid_request: "The request is invalid",
  video_not_found: "That video wasn't found in this workspace",
  import_not_found: "That import wasn't found",
  import_unavailable: "The import couldn't be started",
  product_not_found: "That product wasn't found",
  currency_required: "This product's price can only be set with its currency",
  save_failed: "The change couldn't be saved",
  whatsapp_not_connected: "No WhatsApp number is connected to this workspace",
  not_enough_products: "Not enough products with photos for this draft",
  storage_full: "The company's media storage is full",
  draft_failed: "The draft couldn't be made",
  whatsapp_intake_unavailable: "Sending videos on WhatsApp isn't set up",
  whatsapp_link_not_found: "That phone or request wasn't found",
  whatsapp_link_linked_elsewhere: "That phone is linked to another workspace",
  whatsapp_link_shop_name_taken:
    "Another workspace with Products has the same name",
  kit_not_found: "That kit wasn't found",
  ad_not_found: "That ad wasn't found",
  ad_not_ready: "The ad can only be changed once it's ready",
  ad_letters_unsupported:
    "Video ads support Latin and Cyrillic letters for now",
  ad_unavailable: "The ad couldn't be started",
  ai_actions_used: "The plan's included AI actions are used up",
  spend_limit: "The company's AI spending limit has been reached",
  trial_ended: "The free trial has ended",
  ai_disabled: "AI is disabled for this company",
  kit_part_busy: "That part of the kit is still being made",
  carousel_found:
    "Meta got the earlier carousel after all, so the edits weren't sent",
  template_name_taken: "This kit already used that template name",
  test_phone_missing: "No test phone number is saved for this user",
  rate_limited: "Too many test sends; try again later",
  meta_refused: "Meta refused the edited part",
  test_phone_is_shop: "The test number is the shop's own WhatsApp number",
  test_phone_unreachable: "The test number can't get WhatsApp messages",
  test_phone_not_allowed: "Meta doesn't allow messages to the test number yet",
  no_pictures_left: "This ad has no budget left for new pictures",
  voice_consent_required: "A voice is cloned only with the speaker's agreement",
  voice_not_found: "This workspace has no cloned voice",
  voice_unavailable: "Voices aren't available right now",
  instagram_not_connected:
    "No Instagram account is connected to this workspace",
  instagram_quota: "Instagram's daily posting limit is reached",
  post_busy: "This ad is already being posted there",
  post_failed: "Instagram didn't publish the post. Nothing was posted",
  post_not_found: "That post wasn't found",
  ads_not_connected: "Meta Ads isn't connected to this workspace",
  page_whatsapp_missing:
    "The Facebook Page has no WhatsApp number linked. Link it in Business Suite",
  ctwa_failed: "Meta didn't create the ad. Nothing was spent",
  budget_refused: "That budget is above what this ad may spend",
  run_disabled: "Running ads isn't turned on",
  price_to_check: "A product's price needs checking first",
};

export const productsJson = (data: unknown, status = 200) =>
  noStoreJson(data, status, { cacheControl: "private, no-store" });

/**
 * The error answer for `code`. `extra` adds a 400's `issues` (keep the first
 * 3) or carousel_found's `kit`.
 */
export const productsFail = (
  code: ProductsErrorCode,
  status: number,
  extra: Pick<ProductsErrorBody, "issues" | "kit"> = {}
) =>
  productsJson(
    {
      error: ERROR_MESSAGES[code],
      code,
      ...extra,
    } satisfies ProductsErrorBody,
    status
  );

/**
 * Admins only, behind the `products` flag. Gives the user id, or the answer
 * to send instead: membership's own 401/403, 404 while the flag is off, 403
 * for a member who isn't an admin.
 */
export async function requireProductsAdmin(
  workspaceId: string
): Promise<{ userId: string } | { response: Response }> {
  const access = await resolveProductsAccess(workspaceId);
  if ("error" in access) return { response: access.error };
  if (!access.enabled)
    return { response: productsFail("feature_disabled", 404) };
  if (!access.isAdmin) return { response: productsFail("admin_required", 403) };
  return { userId: access.userId };
}
