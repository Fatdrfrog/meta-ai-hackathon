import "server-only";
import { isObjectIdText } from "@/lib/products/kit-request";
import { shopWords } from "@/lib/products/shop-words";
import { sendWhatsappInteractiveFlow } from "@/lib/whatsapp";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { ProductKit, type IProductKit } from "@/models/product-kit";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";

// "Send me the order form" (stretch S1): a kit's published order form, sent
// to the signed-in owner's own test phone as the interactive Flow message
// buyers would get, so the form can be tried on a phone before any buyer
// sees it.

/** Meta's refusals of a send to the owner's test phone, as the kit's codes. */
const TEST_PHONE_REFUSALS = {
  // The test phone is the shop's own WhatsApp number.
  131021: "test_phone_is_shop",
  // The test phone can't get WhatsApp messages.
  131026: "test_phone_unreachable",
  // Meta doesn't allow messages to it yet (a test number not on the list).
  131030: "test_phone_not_allowed",
} as const;

type TestPhoneRefusal =
  (typeof TEST_PHONE_REFUSALS)[keyof typeof TEST_PHONE_REFUSALS];

/** Why the form wasn't sent. */
export type ProductKitFormTestRefusal =
  | "kit_part_busy"
  | "invalid_request"
  | "whatsapp_not_connected"
  | TestPhoneRefusal;

/** Meta's error code on a refused send; null for any other failure. */
function metaErrorCode(error: unknown): number | null {
  if (!(error instanceof MetaGraphRequestError)) return null;
  const details =
    error.details && typeof error.details === "object"
      ? (error.details as { error?: { code?: unknown } }).error
      : undefined;
  return typeof details?.code === "number" ? details.code : null;
}

/**
 * Sends the kit's published order form to `to` (the owner's saved test
 * phone): its own call to action and the products question's words, in the
 * kit's language. A form still being made is busy; one that isn't
 * published can't be sent. Null when the kit isn't this workspace's.
 */
export async function sendProductKitFormTest(params: {
  workspaceId: string;
  kitId: string;
  to: string;
}): Promise<{ sent: true } | { refused: ProductKitFormTestRefusal } | null> {
  const { workspaceId, kitId, to } = params;
  if (!isObjectIdText(kitId)) return null;
  const doc = await ProductKit.findOne({
    _id: kitId,
    workspaceId,
  }).lean<IProductKit>();
  if (!doc) return null;
  const form = doc.parts?.orderForm;
  if (form?.state === "making") return { refused: "kit_part_busy" };
  if (form?.state !== "ready" || !form.flowId)
    return { refused: "invalid_request" };

  const access = await getWhatsAppWorkspaceContext(workspaceId, {
    requireManager: true,
    requirePhoneNumber: true,
  });
  if (access.error) {
    // An unreadable connection isn't a missing one.
    if (access.error.status >= 500)
      throw new Error(
        `The WhatsApp connection couldn't be read (${access.error.status})`
      );
    return { refused: "whatsapp_not_connected" };
  }
  const { accessToken, phoneNumberId } = access.context;
  if (!accessToken || !phoneNumberId)
    return { refused: "whatsapp_not_connected" };

  const words = shopWords(doc.language);
  try {
    await sendWhatsappInteractiveFlow(phoneNumberId, accessToken, to, {
      flowId: form.flowId,
      mode: "published",
      flowCta: form.config?.ctaText?.trim() || words.form.cta,
      bodyText: words.form.products,
      flowActionType: "navigate",
      flowActionPayload: { screen: form.config?.screens?.[0]?.id ?? "ORDER" },
    });
  } catch (error) {
    const code = metaErrorCode(error);
    const refusal =
      code !== null && code in TEST_PHONE_REFUSALS
        ? TEST_PHONE_REFUSALS[code as keyof typeof TEST_PHONE_REFUSALS]
        : null;
    if (refusal) return { refused: refusal };
    throw error;
  }
  return { sent: true };
}
