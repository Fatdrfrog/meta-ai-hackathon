import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebsiteCartRow } from "../src/models/website-cart";

test("Mongo cart receipts, ownership and terminal fences hold under concurrent ingress", async () => {
  // This suite can only connect to its dedicated local fixture database.
  process.env.MONGODB_URI = "mongodb://127.0.0.1:28019/airi_website_cart_test";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "local-fixture-key";
  process.env.ENCRYPTION_SECRET = "local-fixture-encryption-key";
  const mongoose = (await import("mongoose")).default;
  const { default: WebsiteCart } = await import("../src/models/website-cart");
  const { default: WebsiteCommerceEvent } = await import(
    "../src/models/website-commerce-event"
  );
  const { recordBrowserCartEvent, applyWebsiteStoreEvent, listWebsiteCarts } =
    await import("../src/lib/commerce/carts");
  const { createWhatsAppMarketingConsentUpserter } = await import(
    "../src/lib/whatsapp/marketing-consent"
  );
  const { Conversation } = await import("../src/models/conversation");
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    await mongoose.connection.dropDatabase();
    await WebsiteCart.createIndexes();
    await WebsiteCommerceEvent.createIndexes();
    const base = {
      workspaceId: "workspace",
      widgetSourceId: "widget",
      ownerSessionId: "owner",
      allowedDomains: ["shop.example"],
    };
    const event = {
      eventId: "event-1",
      type: "cart_updated",
      cartId: "cart-1",
      occurredAt: new Date(Date.now() - 1000).toISOString(),
      checkoutId: "checkout-1",
      currency: "KZT",
      recoveryUrl: "https://shop.example/cart/restore/1",
      items: [{ id: "sku", name: "Tea", price: 200, quantity: 1 }],
    };
    const retries = await Promise.all(
      Array.from({ length: 8 }, () =>
        recordBrowserCartEvent({ ...base, event })
      )
    );
    assert.equal(await WebsiteCart.countDocuments(), 1);
    assert.ok(retries.every(cart => cart.total === 200));
    assert.equal(
      (await listWebsiteCarts({ ...base, whatsappSourceId: "wa" })).length,
      1
    );
    assert.deepEqual(
      await listWebsiteCarts({
        ...base,
        whatsappSourceId: "wa",
        ownerSessionId: "stranger",
      }),
      []
    );
    assert.deepEqual(
      await listWebsiteCarts({
        ...base,
        whatsappSourceId: "wa",
        workspaceId: "other",
      }),
      []
    );
    const persisted = await WebsiteCart.findOne({
      cartId: "cart-1",
    }).lean<WebsiteCartRow>();
    assert.ok(persisted);
    assert.equal(persisted.version, 1);
    assert.equal(persisted.recentEvents.length, 1);
    await assert.rejects(
      recordBrowserCartEvent({ ...base, ownerSessionId: "attacker", event }),
      /another session/
    );
    await assert.rejects(
      recordBrowserCartEvent({
        ...base,
        event: { ...event, cartId: "cart-2" },
      }),
      /Checkout already/
    );

    // Pause the browser write after it has read the active snapshot. Commit an order first.
    const originalUpdate = WebsiteCart.findOneAndUpdate;
    let intercepted = false;
    WebsiteCart.findOneAndUpdate = function (
      ...args: Parameters<typeof originalUpdate>
    ) {
      return {
        lean: async () => {
          if (!intercepted) {
            intercepted = true;
            await applyWebsiteStoreEvent({
              eventId: "merchant-order",
              provider: "generic",
              workspaceId: base.workspaceId,
              widgetSourceId: base.widgetSourceId,
              cartId: event.cartId,
              orderId: "order-1",
              type: "order_placed",
              occurredAt: new Date().toISOString(),
            });
          }
          return originalUpdate.apply(WebsiteCart, args).lean();
        },
      };
    } as typeof originalUpdate;
    try {
      const late = await recordBrowserCartEvent({
        ...base,
        event: {
          ...event,
          eventId: "late-cart",
          occurredAt: new Date().toISOString(),
          items: [{ ...event.items[0], quantity: 3 }],
        },
      });
      assert.equal(late.status, "ordered");
      assert.equal(late.total, 200);
    } finally {
      WebsiteCart.findOneAndUpdate = originalUpdate;
    }
    const orderedRow = await WebsiteCart.findById(
      persisted._id
    ).lean<WebsiteCartRow>();
    assert.ok(orderedRow);
    assert.equal(orderedRow.status, "ordered");

    await WebsiteCart.updateOne(
      { _id: persisted._id },
      {
        $set: {
          whatsappSourceId: "old-wa",
          conversationId: new mongoose.Types.ObjectId(),
          consentAt: new Date(),
        },
      }
    );
    assert.equal(
      (
        await recordBrowserCartEvent({
          ...base,
          whatsappSourceId: "new-wa",
          event,
        })
      ).linked,
      true
    );
    const historicalRow = await WebsiteCart.findById(
      persisted._id
    ).lean<WebsiteCartRow>();
    assert.ok(historicalRow);
    assert.equal(historicalRow.whatsappSourceId, "old-wa");
    await WebsiteCart.updateOne(
      { _id: persisted._id },
      { $set: { status: "cart" } }
    );
    const rebound = await recordBrowserCartEvent({
      ...base,
      whatsappSourceId: "new-wa",
      event,
    });
    assert.equal(rebound.linked, false);
    const reboundRow = await WebsiteCart.findById(
      persisted._id
    ).lean<WebsiteCartRow>();
    assert.ok(reboundRow);
    assert.equal(reboundRow.whatsappSourceId, "new-wa");
    assert.equal(reboundRow.conversationId, undefined);

    const conversationId = new mongoose.Types.ObjectId();
    const optOutAt = new Date("2026-09-12T10:00:00Z");
    await Conversation.collection.insertOne({
      _id: conversationId,
      workspaceId: "workspace",
      channel: "whatsapp",
      whatsapp_opt_in: { status: false, updatedAt: optOutAt },
    });
    const consent = createWhatsAppMarketingConsentUpserter({
      connectDB: async () => undefined,
      conversationModel: Conversation,
      supabaseAdmin: {
        from: () => ({ upsert: async () => ({ error: null }) }),
      },
    });
    const consentInput = {
      workspaceId: "workspace",
      sourceId: "source",
      conversationId: String(conversationId),
      source: "checkout_checkbox" as const,
      eventKey: "consent-fixture",
      status: true,
    };
    await consent({
      ...consentInput,
      eventAt: new Date(optOutAt.getTime() - 1000),
    });
    await consent({ ...consentInput, eventAt: optOutAt });
    assert.equal(
      (await Conversation.collection.findOne({ _id: conversationId }))
        ?.whatsapp_opt_in.status,
      false
    );
    await consent({
      ...consentInput,
      eventAt: new Date(optOutAt.getTime() + 1000),
    });
    assert.equal(
      (await Conversation.collection.findOne({ _id: conversationId }))
        ?.whatsapp_opt_in.status,
      true
    );
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
