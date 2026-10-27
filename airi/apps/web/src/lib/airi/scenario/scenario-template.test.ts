import {
  buildWhatsAppReferralTemplateAliases,
  pickWhatsAppReferralFields,
} from "@icecore/whatsapp/referralFields";
import {
  listScenarioTemplateContextPaths,
  SCENARIO_TEMPLATE_CONTEXT_SHAPE,
  SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS,
} from "@icecore/scenario-contracts";
import { applyScenarioReplyTemplate } from "./scenario-template";

type TemplateParams = Parameters<typeof applyScenarioReplyTemplate>[0];

const params = {
  reply: "Base reply",
  channel: "whatsapp",
  conversation: {
    _id: "conv-1",
    chat: "chat-1",
    preferred_language: "en",
    internal_labels: ["vip", "", "stage:won"],
    last_inbound_at: "2026-07-12T10:00:00.000Z",
  },
  chatDocument: {
    first_name: "Ada",
    last_name: "Lovelace",
    username: "ada",
    title: "Ada L",
  },
  whatsAppInfo: {
    contactData: {
      waId: "77011234567",
      userId: "user-1",
      parentUserId: "parent-1",
      profile: { name: "Ada WA" },
    },
  },
  triggerMessage: {
    _id: "msg-1",
    text: "Hi there",
    whatsappReferral: {
      sourceType: "ad",
      sourceId: "123",
      sourceUrl: "https://www.instagram.com/p/x/",
      campaignName: "Summer",
      headline: "Sale",
      ctwaClid: "clid",
      ref: "ref-1",
    },
  },
  configuredLinks: ["https://a.test/1", "https://a.test/2"],
  configuredImages: ["https://img.test/1"],
  calendarAvailability: {
    connected: true,
    nextFreeSlot: "Mon 10:00",
    nextFreeSlotEnd: "Mon 10:30",
    timeZone: "UTC",
    slotCount: 2,
  },
  now: new Date("2026-07-12T12:00:00.000Z"),
  promptInputs: { name: "Amina", sport: "judo" },
  pickedOption: {
    sourceActionNodeId: "carousel-1",
    optionId: "wsc:carousel-1:gold",
    label: "Buy",
    cardIndex: 0,
    cardBodyText: "Gold frame",
    pickedAt: "2026-07-12T11:00:00.000Z",
  },
  routedOffice: {
    sourceActionNodeId: "ask-location",
    inboundMessageId: "msg-location",
    sharedAt: "2026-07-12T11:30:00.000Z",
    decidedAt: "2026-07-12T11:30:01.000Z",
    source: "turn",
    outcome: "route",
    routeId: "kz",
    office: {
      key: "almaty_abay",
      name: "Abay",
      country: "KZ",
      city: "Almaty",
      cityKey: "almaty",
      address: "Abay Ave 10",
      phone: "+7 727 000 00 00",
      tags: [],
      latitude: 43.24,
      longitude: 76.91,
    },
    distanceMeters: 2140,
  },
} as unknown as TemplateParams;

const referral = {
  sourceType: "ad",
  sourceId: "123",
  sourceUrl: "https://www.instagram.com/p/x/",
  sourcePlatform: "instagram",
  campaignId: "",
  campaignName: "Summer",
  adSetId: "",
  adSetName: "",
  headline: "Sale",
  body: "",
  mediaType: "",
  imageUrl: "",
  videoUrl: "",
  thumbnailUrl: "",
  ctwaClid: "clid",
  ref: "ref-1",
  welcomeMessageText: "",
  hasReferral: "true",
};

/** Captured from the renderer before it moved to the shared grammar. */
const RENDERED_BY_PATH: Record<string, string> = {
  reply: "<{{reply}}>",
  channel: "whatsapp",
  link: "https://a.test/1",
  link1: "https://a.test/1",
  link2: "https://a.test/2",
  link3: "",
  link4: "",
  link5: "",
  image: "https://img.test/1",
  image1: "https://img.test/1",
  image2: "",
  image3: "",
  image4: "",
  image5: "",
  "links.first": "https://a.test/1",
  "links.count": "2",
  "images.first": "https://img.test/1",
  "images.count": "1",
  first_name: "Ada",
  last_name: "Lovelace",
  username: "ada",
  customer_name: "Ada WA",
  "customer.name": "Ada WA",
  "customer.firstName": "Ada",
  "customer.lastName": "Lovelace",
  "customer.username": "ada",
  "customer.id": "chat-1",
  "whatsappclient.name": "Ada WA",
  "whatsappclient.wa_id": "77011234567",
  "whatsappclient.user_id": "user-1",
  "whatsappclient.parent_user_id": "parent-1",
  "chat.id": "chat-1",
  "chat.title": "Ada L",
  "chat.first_name": "Ada",
  "chat.last_name": "Lovelace",
  "chat.username": "ada",
  "conversation.id": "conv-1",
  "conversation.channel": "whatsapp",
  "conversation.preferred_language": "en",
  "conversation.internal_labels": "vip, stage:won",
  "trigger.message.id": "msg-1",
  "trigger.message.text": "Hi there",
  ...Object.fromEntries(
    Object.entries(referral).flatMap(([field, value]) => [
      [`trigger.whatsappReferral.${field}`, value],
      [`whatsappReferral.${field}`, value],
    ])
  ),
  whatsapp_referral_source_type: "ad",
  whatsapp_referral_source_id: "123",
  whatsapp_referral_source_url: "https://www.instagram.com/p/x/",
  whatsapp_referral_source_platform: "instagram",
  whatsapp_referral_campaign_id: "",
  whatsapp_referral_campaign_name: "Summer",
  whatsapp_referral_ad_set_id: "",
  whatsapp_referral_ad_set_name: "",
  whatsapp_referral_headline: "Sale",
  whatsapp_referral_body: "",
  whatsapp_referral_media_type: "",
  whatsapp_referral_image_url: "",
  whatsapp_referral_video_url: "",
  whatsapp_referral_thumbnail_url: "",
  whatsapp_referral_ctwa_clid: "clid",
  whatsapp_referral_ref: "ref-1",
  whatsapp_referral_welcome_message_text: "",
  meta_ad_source_type: "ad",
  meta_ad_source_id: "123",
  meta_ad_source_url: "https://www.instagram.com/p/x/",
  meta_ad_source_platform: "instagram",
  meta_ad_campaign_id: "",
  meta_ad_campaign_name: "Summer",
  meta_ad_ad_set_id: "",
  meta_ad_ad_set_name: "",
  meta_ad_headline: "Sale",
  meta_ad_body: "",
  ctwa_clid: "clid",
  ctwa_ref: "ref-1",
  "calendar.connected": "yes",
  "calendar.next_free_slot": "Mon 10:00",
  "calendar.next_free_slot_end": "Mon 10:30",
  "calendar.time_zone": "UTC",
  "calendar.slot_count": "2",
  countdown: "22 hours left",
  "countdown.days": "0",
  "countdown.hours": "22",
  "countdown.minutes": "1320",
  "countdown.humanized": "22 hours left",
  "countdown.expired": "",
  "countdown.iso": "2026-07-13T10:00:00.000Z",
  // Added with picked options; not part of the captured renderer.
  "picked.label": "Buy",
  "picked.text": "Gold frame",
  // Added with location routes.
  "office.name": "Abay",
  "office.address": "Abay Ave 10",
  "office.city": "Almaty",
  "office.phone": "+7 727 000 00 00",
  "office.distance_km": "2.1",
  "office.maps_url": "https://www.google.com/maps?q=43.24,76.91",
};

function render(token: string, overrides: Partial<TemplateParams> = {}) {
  return applyScenarioReplyTemplate({
    ...params,
    ...overrides,
    reply: `<{{${token}}}>`,
  });
}

describe("applyScenarioReplyTemplate context", () => {
  it("renders every described path exactly as before", () => {
    expect(Object.keys(RENDERED_BY_PATH).sort()).toEqual(
      [...listScenarioTemplateContextPaths()].sort()
    );
    for (const [path, rendered] of Object.entries(RENDERED_BY_PATH)) {
      expect([path, render(path)]).toEqual([path, `<${rendered}>`]);
    }
  });

  it("renders form answers by form and field, and a missing one empty", () => {
    const formAnswers = { order: { size: "Large" }, contact: {} };
    expect(render("form.order.size", { formAnswers })).toBe("<Large>");
    // A blank answer, a form never submitted and a malformed token.
    for (const token of [
      "form.contact.name",
      "form.billing.name",
      "form.order",
      "form.Order.size",
    ]) {
      expect([token, render(token, { formAnswers })]).toEqual([token, "<>"]);
    }
    expect(render("form.order.size")).toBe("<>");
  });

  it("renders the nearest office empty until a shared location finds one", () => {
    for (const token of [
      "office.name",
      "office.distance_km",
      "office.maps_url",
    ]) {
      expect([token, render(token, { routedOffice: null })]).toEqual([
        token,
        "<>",
      ]);
    }
  });

  it("renders the picked option empty until the customer taps one", () => {
    expect(render("picked.label", { pickedOption: null })).toBe("<>");
    expect(render("picked.text", { pickedOption: undefined })).toBe("<>");
    expect(
      render("picked.text", {
        pickedOption: {
          sourceActionNodeId: "buttons-1",
          optionId: "wsc:buttons-1:yes",
          label: "Yes",
          pickedAt: "",
        },
      })
    ).toBe("<>");
  });

  it("keeps collected answers, legacy path quirks and unknown paths as before", () => {
    expect(render("input.name")).toBe("<Amina>");
    expect(render("input.sport")).toBe("<judo>");
    expect(render("countdown.")).toBe("<22 hours left>");
    expect(render("customer..name")).toBe("<Ada WA>");
    for (const token of [
      "link6",
      "customer.firstname",
      "input.Name",
      "calendar",
      "links.values",
    ]) {
      expect([token, render(token)]).toEqual([token, "<>"]);
    }
    expect(
      applyScenarioReplyTemplate({
        ...params,
        configuredLinks: [],
        configuredImages: [],
        reply:
          "<{{links.first}}|{{images.first}}|{{link}}|{{link1}}|{{links.count}}>",
      })
    ).toBe("<||||0>");
  });

  it("no longer renders the internal link and image arrays", () => {
    // They were never described or offered; only numbered slots are.
    expect(render("links.values.0")).toBe("<>");
    expect(render("links.values.length")).toBe("<>");
    expect(render("images.values.0")).toBe("<>");
  });

  it("describes exactly the WhatsApp referral fields and aliases the runtime provides", () => {
    const fields = pickWhatsAppReferralFields({});
    expect(Object.keys(fields).sort()).toEqual(
      Object.keys(SCENARIO_TEMPLATE_CONTEXT_SHAPE.whatsappReferral).sort()
    );
    expect(
      Object.keys(buildWhatsAppReferralTemplateAliases(fields)).sort()
    ).toEqual([...SCENARIO_TEMPLATE_REFERRAL_ALIAS_KEYS].sort());
  });
});
