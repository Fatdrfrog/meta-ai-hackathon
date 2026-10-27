import { createHash, createHmac } from "node:crypto";
import { Types } from "mongoose";
import { normalizeCommerceTrackingEvent } from "@icecore/shared/types/commerce-tracking";
import connectDB from "@/lib/mongoose";
import WebsiteCart, { type WebsiteCartRow } from "@/models/website-cart";
import { Conversation } from "@/models/conversation";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import {
  ensureCustomerForConversation,
  recordCustomerEvent,
} from "@/lib/customers/service";
import {
  ACTIVE_CART_STATES,
  publicCart,
  reduceWebsiteCart,
  validateRecoveryUrl,
  WebsiteCartError,
} from "./cart-state";
import {
  resolveWebsiteCommerceContext,
  WebsiteCommerceIntegrationError,
} from "./integrations";
import type { StoreEvent } from "./store-events";

export async function listWebsiteCarts(input: {
  workspaceId: string;
  widgetSourceId: string;
  ownerSessionId: string;
  whatsappSourceId: string;
}) {
  await connectDB();
  const carts = await WebsiteCart.find({
    workspaceId: input.workspaceId,
    widgetSourceId: input.widgetSourceId,
    ownerSessionId: input.ownerSessionId,
    expiresAt: { $gt: new Date() },
  })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean<WebsiteCartRow[]>();
  return carts.map(cart => ({
    ...publicCart(cart),
    linked: Boolean(
      cart.conversationId &&
        cart.consentAt &&
        cart.whatsappSourceId === input.whatsappSourceId
    ),
  }));
}

export async function recordBrowserCartEvent(input: {
  workspaceId: string;
  widgetSourceId: string;
  ownerSessionId: string;
  allowedDomains: string[];
  event: unknown;
  whatsappSourceId?: string;
}) {
  let event;
  try {
    event = normalizeCommerceTrackingEvent(input.event);
  } catch {
    throw new WebsiteCartError("Invalid cart event");
  }
  event.recoveryUrl = validateRecoveryUrl(
    event.recoveryUrl,
    input.allowedDomains
  );
  await connectDB();
  const scope = { widgetSourceId: input.widgetSourceId, cartId: event.cartId };
  for (let attempt = 0; attempt < 6; attempt++) {
    const cart = await WebsiteCart.findOne(scope).lean<WebsiteCartRow>();
    if (
      cart &&
      (cart.workspaceId !== input.workspaceId ||
        cart.ownerSessionId !== input.ownerSessionId)
    )
      throw new WebsiteCartError("Cart belongs to another session", 409);
    if (
      cart?.whatsappSourceId &&
      ACTIVE_CART_STATES.includes(cart.status) &&
      input.whatsappSourceId &&
      cart.whatsappSourceId !== input.whatsappSourceId
    ) {
      await WebsiteCart.updateOne(
        {
          _id: cart._id,
          status: cart.status,
          whatsappSourceId: cart.whatsappSourceId,
        },
        {
          $set: {
            whatsappSourceId: input.whatsappSourceId,
            admissionPending: false,
          },
          $unset: {
            conversationId: "",
            customerId: "",
            consentAt: "",
            handoffHash: "",
            handoffMessageId: "",
          },
        }
      );
      continue;
    }
    const patch = reduceWebsiteCart(cart, event);
    if (!patch) return publicCart(cart!);
    if (!cart) {
      try {
        const created = await WebsiteCart.create({
          ...scope,
          ...patch,
          workspaceId: input.workspaceId,
          ownerSessionId: input.ownerSessionId,
        });
        return publicCart(created.toObject() as WebsiteCartRow);
      } catch (error) {
        if (!isMongoDuplicateKeyError(error)) throw error;
        // A checkout alias owned by another cart must not be reassigned.
        if (event.checkoutId && !(await WebsiteCart.exists(scope)))
          throw new WebsiteCartError(
            "Checkout already belongs to another cart",
            409
          );
        continue;
      }
    }
    try {
      const saved = await WebsiteCart.findOneAndUpdate(
        {
          ...scope,
          ownerSessionId: input.ownerSessionId,
          status: cart.status,
          version: cart.version,
          eventId: cart.eventId,
        },
        { $set: patch },
        { new: true }
      ).lean<WebsiteCartRow>();
      if (saved) return publicCart(saved);
    } catch (error) {
      if (isMongoDuplicateKeyError(error))
        throw new WebsiteCartError(
          "Checkout already belongs to another cart",
          409
        );
      throw error;
    }
  }
  throw new WebsiteCartError(
    "Cart changed concurrently; retry the same event",
    409
  );
}

const consentText: Record<string, string> = {
  en: "Please save my cart. I agree to receive cart reminders and other offers from this business on WhatsApp.",
  ru: "Сохраните мою корзину. Я согласен получать напоминания о корзине и другие предложения от этой компании в WhatsApp.",
  kz: "Себетімді сақтаңыз. Осы компаниядан WhatsApp арқылы себет туралы еске салулар мен басқа ұсыныстар алуға келісемін.",
  uz: "Savatimni saqlang. Ushbu kompaniyadan WhatsApp orqali savat eslatmalari va boshqa takliflarni olishga roziman.",
};
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
function handoffToken(cartId: string, issuedAt: Date) {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("Cart handoff signing unavailable");
  return createHmac("sha256", secret)
    .update(
      `website-cart-handoff:${cartId}:${new Date(issuedAt).toISOString()}`
    )
    .digest("hex")
    .slice(0, 48);
}

export async function createCartHandoff(input: {
  widgetSourceId: string;
  ownerSessionId: string;
  cartId: string;
  locale?: string;
}) {
  const context = await resolveWebsiteCommerceContext(input.widgetSourceId);
  await connectDB();
  const text = consentText[input.locale || "en"] || consentText.en;
  const scope = {
    widgetSourceId: input.widgetSourceId,
    ownerSessionId: input.ownerSessionId,
    workspaceId: context.widgetSource.workspace_id,
    cartId: input.cartId,
    status: { $in: ACTIVE_CART_STATES },
    expiresAt: { $gt: new Date() },
  };
  const previous = await WebsiteCart.findOne(scope).lean<WebsiteCartRow>();
  if (!previous?.items.length)
    throw new WebsiteCartError("Active cart not found", 404);
  if (
    !validateRecoveryUrl(
      previous.recoveryUrl,
      context.widgetSource.credentials.allowed_domains
    )
  )
    throw new WebsiteCartError("Cart recovery link is unavailable", 409);
  const raw = context.whatsappSource.credentials as Record<string, unknown>;
  const phone = String(
    raw.display_phone_number || raw.business_phone_number || ""
  ).replace(/\D/g, "");
  if (!/^\d{7,15}$/.test(phone))
    throw new WebsiteCartError("WhatsApp business phone unavailable", 409);
  const link = (token: string, message: string) =>
    `https://wa.me/${phone}?text=${encodeURIComponent(`${message}\nAIRI-CART:${token}`)}`;
  if (
    previous.handoffHash &&
    previous.handoffMessageId &&
    previous.handoffExpiresAt &&
    previous.handoffExpiresAt > new Date()
  )
    throw new WebsiteCartError(
      "Cart link is being confirmed; retry shortly",
      409
    );
  const rebound =
    previous.whatsappSourceId &&
    previous.whatsappSourceId !== context.whatsappSource.id;
  if (
    !rebound &&
    previous.handoffHash &&
    previous.handoffIssuedAt &&
    previous.handoffExpiresAt &&
    previous.handoffExpiresAt > new Date()
  ) {
    const token = handoffToken(String(previous._id), previous.handoffIssuedAt);
    if (tokenHash(token) !== previous.handoffHash)
      throw new WebsiteCartError(
        "Cart link needs to expire before renewal",
        409
      );
    return link(token, previous.handoffConsentText || text);
  }
  const issuedAt = new Date();
  const token = handoffToken(String(previous._id), issuedAt);
  const cart = await WebsiteCart.findOneAndUpdate(
    {
      ...scope,
      _id: previous._id,
      whatsappSourceId: previous.whatsappSourceId || { $exists: false },
      handoffMessageId: previous.handoffMessageId || { $exists: false },
      handoffHash: previous.handoffHash || { $exists: false },
    },
    {
      $unset: {
        handoffMessageId: "",
        ...(rebound
          ? { conversationId: "", customerId: "", consentAt: "" }
          : {}),
      },
      $set: {
        handoffHash: tokenHash(token),
        handoffExpiresAt: new Date(Date.now() + 15 * 60_000),
        handoffIssuedAt: issuedAt,
        handoffConsentText: text,
        whatsappSourceId: context.whatsappSource.id,
        ...(rebound ? { admissionPending: false } : {}),
      },
    },
    { new: true }
  ).lean<WebsiteCartRow>();
  if (!cart?.items.length)
    throw new WebsiteCartError("Active cart not found", 404);
  return link(token, text);
}

/** Called only after canonical WhatsApp ingress authenticates and persists the sender. */
export async function claimWebsiteCartFromWhatsApp(input: {
  workspaceId: string;
  sourceId: string;
  conversationId: string;
  text: string;
  messageId: string;
  occurredAt: Date;
}) {
  const match = input.text.match(/\nAIRI-CART:([a-f0-9]{48})$/);
  if (!match) return false;
  await connectDB();
  const hash = tokenHash(match[1]);
  const cart = await WebsiteCart.findOne({
    workspaceId: input.workspaceId,
    handoffHash: hash,
    whatsappSourceId: input.sourceId,
  }).lean<WebsiteCartRow>();
  if (
    !cart ||
    input.text !== `${cart.handoffConsentText}\nAIRI-CART:${match[1]}` ||
    !cart.handoffExpiresAt ||
    !cart.handoffIssuedAt ||
    input.occurredAt > new Date(cart.handoffExpiresAt) ||
    input.occurredAt.getTime() <
      new Date(cart.handoffIssuedAt).getTime() - 60_000 ||
    (cart.handoffMessageId && cart.handoffMessageId !== input.messageId) ||
    (cart.conversationId &&
      String(cart.conversationId) !== input.conversationId)
  )
    return false;
  const context = await resolveWebsiteCommerceContext(cart.widgetSourceId);
  if (context.whatsappSource.id !== input.sourceId) return false;
  const conversation = await Conversation.findOne({
    _id: input.conversationId,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    channel: "whatsapp",
  }).lean();
  if (!conversation) return false;
  const customer = await ensureCustomerForConversation({
    conversationId: input.conversationId,
    linkMethod: "system",
  });
  const customerId = (customer as { _id?: unknown } | null)?._id;
  if (!customerId) throw new Error("Cart customer unavailable");
  // A replay can finish consent persistence, but must not transfer the cart to another sender.
  const bound = await WebsiteCart.updateOne(
    {
      _id: cart._id,
      handoffHash: hash,
      $or: [
        { conversationId: { $exists: false } },
        { conversationId: new Types.ObjectId(input.conversationId) },
      ],
      $and: [
        {
          $or: [
            { handoffMessageId: { $exists: false } },
            { handoffMessageId: input.messageId },
          ],
        },
      ],
    },
    {
      $set: {
        conversationId: input.conversationId,
        customerId,
        handoffMessageId: input.messageId,
      },
    }
  );
  if (!bound.matchedCount) return false;
  const { upsertWhatsAppMarketingConsent } = await import(
    "@/lib/whatsapp/marketing-consent"
  );
  await upsertWhatsAppMarketingConsent({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    conversationId: input.conversationId,
    source: "checkout_checkbox",
    status: true,
    eventAt: input.occurredAt,
    eventKey: `website-cart:${cart._id}:${input.messageId}`,
    detail: cart.handoffConsentText,
    checkoutFlow: cart.cartId,
    payload: {
      messageId: input.messageId,
      widgetSourceId: cart.widgetSourceId,
      cartId: cart.cartId,
    },
  });
  const effectiveConsent = await Conversation.findOne({
    _id: input.conversationId,
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    channel: "whatsapp",
  })
    .select("whatsapp_opt_in")
    .lean<{ whatsapp_opt_in?: { status?: boolean } }>();
  if (effectiveConsent?.whatsapp_opt_in?.status !== true) {
    await WebsiteCart.updateOne(
      { _id: cart._id, handoffHash: hash },
      {
        $unset: { handoffHash: "", consentAt: "" },
        $set: { admissionPending: false },
      }
    );
    return false;
  }
  const consentSaved = await WebsiteCart.updateOne(
    { _id: cart._id, conversationId: input.conversationId, handoffHash: hash },
    {
      $set: {
        consentAt: input.occurredAt,
        admissionPending: true,
        nextAdmissionAt: new Date(),
      },
      $unset: { handoffHash: "" },
    }
  );
  if (!consentSaved.matchedCount)
    throw new Error("Cart handoff changed during consent persistence");
  return true;
}

/** Compact cart state is projected only once per meaningful, contactable revision. */
export async function admitWebsiteCarts(input: {
  limit: number;
  deadlineAtMs: number;
}) {
  await connectDB();
  const carts = await WebsiteCart.find({
    admissionPending: true,
    nextAdmissionAt: { $lte: new Date() },
  })
    .sort({ nextAdmissionAt: 1, _id: 1 })
    .limit(input.limit)
    .lean<WebsiteCartRow[]>();
  let failures = 0;
  for (const cart of carts) {
    if (Date.now() >= input.deadlineAtMs) break;
    const claim = await WebsiteCart.updateOne(
      {
        _id: cart._id,
        version: cart.version,
        nextAdmissionAt: { $lte: new Date() },
      },
      { $set: { nextAdmissionAt: new Date(Date.now() + 60_000) } }
    );
    if (!claim.modifiedCount) continue;
    try {
      if (
        ACTIVE_CART_STATES.includes(cart.status) &&
        cart.items.length &&
        cart.conversationId &&
        cart.customerId &&
        cart.consentAt
      ) {
        const context = await resolveWebsiteCommerceContext(
          cart.widgetSourceId
        );
        if (context.whatsappSource.id !== cart.whatsappSourceId) {
          await WebsiteCart.updateOne(
            { _id: cart._id, version: cart.version },
            { $set: { admissionPending: false } }
          );
          continue;
        }
        await recordCustomerEvent({
          workspaceId: cart.workspaceId,
          customerId: String(cart.customerId),
          conversationId: String(cart.conversationId),
          type: "commerce_behavior",
          occurredAt: cart.activityAt,
          idempotencyKey: `website-cart:${cart._id}:${cart.version}`,
          actor: { type: "system" },
          payload: {
            behavior: {
              sourceId: cart.whatsappSourceId,
              eventType:
                cart.status === "checkout"
                  ? "checkout_started"
                  : "cart_updated",
              referenceId: `website-cart:${cart._id}`,
              websiteCartId: String(cart._id),
              websiteCartVersion: cart.version,
              recoveryUrl: cart.recoveryUrl,
            },
          },
        });
      }
      await WebsiteCart.updateOne(
        { _id: cart._id, version: cart.version },
        { $set: { admissionPending: false } }
      );
    } catch (error) {
      if (
        error instanceof WebsiteCommerceIntegrationError &&
        error.status !== 503
      ) {
        await WebsiteCart.updateOne(
          { _id: cart._id, version: cart.version },
          { $set: { admissionPending: false } }
        );
      } else failures++;
    }
  }
  if (failures)
    throw new Error(`Website cart admission will retry ${failures} carts`);
}

/** Authenticated store facts may arrive before browser identity; the inbox retries that case. */
export async function applyWebsiteStoreEvent(
  event: StoreEvent
): Promise<boolean> {
  await connectDB();
  const aliases = [
    ...(event.cartId ? [{ cartId: event.cartId }] : []),
    ...(event.checkoutId ? [{ checkoutId: event.checkoutId }] : []),
  ];
  if (!aliases.length && event.type !== "refund") return false;
  const matches = aliases.length
    ? await WebsiteCart.find({
        widgetSourceId: event.widgetSourceId,
        workspaceId: event.workspaceId,
        $or: aliases,
      })
        .limit(2)
        .lean<WebsiteCartRow[]>()
    : [];
  if (matches.length > 1)
    throw new WebsiteCartError("Conflicting cart and checkout references", 409);
  const cart = matches[0];
  if (!cart && event.type !== "refund") return false;
  if (cart && event.type !== "refund") {
    const status =
      event.type === "purchase"
        ? "paid"
        : event.type === "order_placed"
          ? "ordered"
          : "closed";
    // Terminal merchant facts outrank browser clocks, and a late order cannot demote a paid cart.
    await WebsiteCart.updateOne(
      {
        _id: cart._id,
        ...(status !== "paid" ? { status: { $ne: "paid" } } : {}),
      },
      { $set: { status, orderId: event.orderId, admissionPending: false } }
    );
  }
  if (event.type !== "purchase" && event.type !== "refund") return true;
  if (
    event.type === "purchase" &&
    (!cart?.conversationId || !cart.whatsappSourceId)
  )
    return false;
  const context = await resolveWebsiteCommerceContext(event.widgetSourceId);
  if (
    event.type === "purchase" &&
    context.whatsappSource.id !== cart?.whatsappSourceId
  )
    return false;
  const { recordCommerceEvent, resolveOriginalCommerceSaleConversation } =
    await import("@/lib/conversions/commerce-events");
  const identity = (id: string) =>
    `website:${createHash("sha256")
      .update(JSON.stringify([event.widgetSourceId, event.provider, id]))
      .digest("hex")}`;
  const conversationId =
    event.type === "refund"
      ? await resolveOriginalCommerceSaleConversation({
          source: context.whatsappSource,
          purchaseTransactionId: identity(event.purchaseTransactionId!),
          currency: event.currency!,
        })
      : String(cart!.conversationId);
  if (!conversationId) return false;
  await recordCommerceEvent({
    source: context.whatsappSource,
    input: {
      eventId: identity(event.eventId),
      eventType: event.type,
      conversationId,
      transactionId: identity(event.transactionId || event.orderId),
      ...(event.type === "refund"
        ? { purchaseTransactionId: identity(event.purchaseTransactionId!) }
        : {}),
      orderId: event.orderId,
      value: event.value,
      currency: event.currency,
      occurredAt: event.occurredAt,
    },
  });
  return true;
}
