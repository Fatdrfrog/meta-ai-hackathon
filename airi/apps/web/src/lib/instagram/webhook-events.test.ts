import {
  buildInstagramMessagingDedupKey,
  classifyInstagramMessagingEvent,
  extractInstagramCommentEvents,
  extractInstagramMessagingEvents,
  INSTAGRAM_BUSINESS_LOGIN_WEBHOOK_FIELDS,
  INSTAGRAM_FACEBOOK_LOGIN_PAGE_WEBHOOK_FIELDS,
  buildInstagramReferralRagContext,
  normalizeInstagramMessagingEvent,
  readInstagramReferralContext,
} from "@/lib/instagram/webhook-events";

describe("Instagram webhook events", () => {
  it("keeps the current official messaging subscriptions in the business-login field set", () => {
    expect(INSTAGRAM_BUSINESS_LOGIN_WEBHOOK_FIELDS).toEqual(
      expect.arrayContaining([
        "messages",
        "messaging_optins",
        "messaging_postbacks",
        "messaging_reactions",
        "messaging_referrals",
        "messaging_seen",
        "comments",
        "live_comments",
      ])
    );
  });

  it("keeps Facebook-login subscriptions backward-compatible with legacy reaction field names", () => {
    expect(INSTAGRAM_FACEBOOK_LOGIN_PAGE_WEBHOOK_FIELDS).toEqual(
      expect.arrayContaining([
        "messages",
        "message_deliveries",
        "message_reads",
        "message_reactions",
        "messaging_postbacks",
        "messaging_referrals",
        "messaging_seen",
        "messaging_optins",
      ])
    );
  });

  it("extracts direct, changed, and standby messaging events", () => {
    const events = extractInstagramMessagingEvents({
      messaging: [{ sender: { id: "direct" }, recipient: { id: "ig" } }],
      standby: [{ sender: { id: "standby" }, recipient: { id: "ig" } }],
      changes: [
        {
          value: {
            messaging: [{ sender: { id: "changed" }, recipient: { id: "ig" } }],
          },
        },
      ],
    });

    expect(events.map(event => event.sender?.id)).toEqual([
      "direct",
      "changed",
      "standby",
    ]);
    expect(events[2].standby).toBe(true);
  });

  it("extracts direct and changed comment events without route-local parsing", () => {
    const events = extractInstagramCommentEvents({
      field: "comments",
      value: { id: "direct-comment", text: "Direct" },
      changes: [
        {
          field: "comments",
          value: { id: "changed-comment", text: "Changed" },
        },
        {
          field: "live_comments",
          value: [{ id: "live-comment", text: "Live" }],
        },
        {
          field: "messages",
          value: { id: "ignored" },
        },
      ],
    });

    expect(events.map(event => event.id)).toEqual([
      "direct-comment",
      "changed-comment",
      "live-comment",
    ]);
  });

  it("classifies official Instagram messaging event variants", () => {
    expect(
      classifyInstagramMessagingEvent({
        sender: { id: "user" },
        recipient: { id: "ig" },
        message: { mid: "m1", is_echo: true },
      })
    ).toBe("message_echo");
    expect(
      classifyInstagramMessagingEvent({
        sender: { id: "user" },
        recipient: { id: "ig" },
        delivery: { mids: ["m1"], watermark: 1760000000000 },
      })
    ).toBe("delivery");
    expect(
      classifyInstagramMessagingEvent({
        sender: { id: "user" },
        recipient: { id: "ig" },
        read: { mid: "m1" },
      })
    ).toBe("read");
    expect(
      classifyInstagramMessagingEvent({
        sender: { id: "user" },
        recipient: { id: "ig" },
        referral: { ref: "campaign" },
      })
    ).toBe("referral");
    expect(
      classifyInstagramMessagingEvent({
        sender: { id: "user" },
        recipient: { id: "ig" },
        optin: { payload: "notify" },
      })
    ).toBe("optin");
    expect(
      classifyInstagramMessagingEvent({
        sender: { id: "user" },
        recipient: { id: "ig" },
        standby: true,
        message: { mid: "m2" },
      })
    ).toBe("standby");
  });

  it("builds dedupe keys for non-message Instagram event variants", () => {
    expect(
      buildInstagramMessagingDedupKey({
        sender: { id: "user" },
        recipient: { id: "ig" },
        delivery: { mids: ["m-delivered"], watermark: 1760000000000 },
      })
    ).toBe("delivery:m-delivered:user:ig:1760000000000");
    expect(
      buildInstagramMessagingDedupKey({
        sender: { id: "user" },
        recipient: { id: "ig" },
        read: { mid: "m-read" },
      })
    ).toBe("read:m-read:user:ig");
    expect(
      buildInstagramMessagingDedupKey({
        sender: { id: "user" },
        recipient: { id: "ig" },
        timestamp: 123,
        referral: { ref: "campaign" },
      })
    ).toContain("referral:user:ig:123:");
    expect(
      buildInstagramMessagingDedupKey({
        sender: { id: "user" },
        recipient: { id: "ig" },
        timestamp: 123,
        optin: { payload: "notify" },
      })
    ).toBe("optin:user:ig:123:notify");
    expect(
      buildInstagramMessagingDedupKey({
        sender: { id: "user" },
        recipient: { id: "ig" },
        timestamp: 123,
        standby: true,
      })
    ).toBe("standby:user:ig:123");
  });

  it("builds bounded referral dedupe keys from normalized referral context", () => {
    const key = buildInstagramMessagingDedupKey({
      sender: { id: "user" },
      recipient: { id: "ig" },
      timestamp: 123,
      referral: {
        source: "ADS",
        type: "OPEN_THREAD",
        ref: "campaign-a",
        ad_id: "ad-42",
        product: {
          id: "product-99",
          retailer_id: "retailer-7",
        },
        ads_context_data: {
          ad_title: "Summer sale",
          post_body: "x".repeat(5000),
        },
        noisy_payload: {
          nested: "this raw payload should not be embedded in the key",
        },
      },
    });

    expect(key).toContain("ref=campaign-a");
    expect(key).toContain("ad=ad-42");
    expect(key).toContain("product=product-99");
    expect(key).not.toContain("noisy_payload");
    expect(key).not.toContain("x".repeat(100));
    expect(key.length).toBeLessThan(220);
  });

  it("normalizes Meta campaign and ad set fields from referrals", () => {
    const referral = readInstagramReferralContext({
      ad_id: "ad-42",
      campaign_id: "campaign-1",
      campaign_name: "Orteke product",
      ad_set_id: "adset-1",
      ad_set_name: "Adults",
    });

    expect(referral).toEqual(
      expect.objectContaining({
        adId: "ad-42",
        campaignId: "campaign-1",
        campaignName: "Orteke product",
        adSetId: "adset-1",
        adSetName: "Adults",
      })
    );
    expect(buildInstagramReferralRagContext(referral)).toContain(
      "campaign_id=campaign-1"
    );
    expect(buildInstagramReferralRagContext(referral)).toContain(
      "adset_id=adset-1"
    );
  });

  it("normalizes sender and recipient ids while preserving event payload", () => {
    const event = normalizeInstagramMessagingEvent({
      sender: { id: 123 as never, username: "alice" },
      recipient: { id: 456 as never },
      message: { mid: "m1", text: "Hello" },
    });

    expect(event.sender).toEqual({ id: "123", username: "alice" });
    expect(event.recipient).toEqual({ id: "456" });
    expect(event.message?.text).toBe("Hello");
  });
});
