import type {
  ScenarioActionAttachment,
  ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";
import {
  applyServiceMessageEditorIntent,
  getAvailableServiceMessageActions,
  projectServiceMessageEditor,
  SERVICE_MESSAGE_EDITOR_ACTIONS,
} from "./service-message-editor-model";

const fixedText = (text: string): ScenarioWhatsAppServiceMessage => ({
  version: 1,
  message: { kind: "text", body: { mode: "fixed", text } },
});

const image: ScenarioActionAttachment & { mediaType: "image" } = {
  mediaType: "image",
  url: "https://cdn.example/hero.png",
  fileName: "hero.png",
};

describe("service message editor model", () => {
  it("never turns an AI instruction into customer-facing fixed text", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "text",
        body: { mode: "ai", instruction: "Ask for the address" },
      },
    };
    expect(
      applyServiceMessageEditorIntent(value, {
        type: "set_body_mode",
        mode: "fixed",
      }).message
    ).toMatchObject({ body: { mode: "fixed", text: "" } });
  });

  it("keeps a text header when the fourth reply becomes a list", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        header: { kind: "text", text: "Order status" },
        options: [1, 2, 3].map(n => ({ id: String(n), label: String(n) })),
      },
    };
    expect(
      applyServiceMessageEditorIntent(value, {
        type: "add_choice",
        option: { id: "4", label: "Four" },
      }).message
    ).toMatchObject({ kind: "list", headerText: "Order status" });
  });
  it("starts a separate empty draft when switching fixed and AI modes", () => {
    const ai = applyServiceMessageEditorIntent(fixedText("Welcome"), {
      type: "set_body_mode",
      mode: "ai",
    });

    expect(ai.message).toEqual({
      kind: "text",
      body: { mode: "ai", instruction: "" },
    });

    expect(
      applyServiceMessageEditorIntent(ai, {
        type: "set_body_mode",
        mode: "fixed",
      }).message
    ).toEqual({
      kind: "text",
      body: { mode: "fixed", text: "" },
    });
  });

  it("projects text into media and keeps the caption", () => {
    const result = applyServiceMessageEditorIntent(fixedText("Caption"), {
      type: "attach_media",
      attachment: image,
    });

    expect(result.message).toEqual({
      kind: "media",
      attachment: image,
      body: { mode: "fixed", text: "Caption" },
    });
    expect(
      projectServiceMessageEditor(result, {
        callingReady: true,
        hasWhatsAppCoexistence: false,
      })
    ).toMatchObject({
      body: { mode: "fixed", text: "Caption" },
      media: image,
      action: null,
    });
  });

  it("attaches audio as a voice note when deliverAsVoice is requested", () => {
    const voice = {
      url: "https://cdn.example/note.ogg",
      mediaType: "audio" as const,
      mimeType: "audio/ogg",
      fileName: "note.ogg",
    };

    const attached = applyServiceMessageEditorIntent(fixedText("Ignored"), {
      type: "attach_media",
      attachment: voice,
      deliverAsVoice: true,
    });

    expect(attached.message).toEqual({
      kind: "media",
      attachment: voice,
      body: undefined,
      deliverAsVoice: true,
    });

    const cleared = applyServiceMessageEditorIntent(attached, {
      type: "set_deliver_as_voice",
      value: false,
    });
    expect(cleared.message).toEqual({
      kind: "media",
      attachment: voice,
      body: undefined,
    });
  });

  it("refuses reply/CTA promotion while audio media is attached", () => {
    const voice = {
      url: "https://cdn.example/note.ogg",
      mediaType: "audio" as const,
      mimeType: "audio/ogg",
      fileName: "note.ogg",
    };
    const media = applyServiceMessageEditorIntent(fixedText("Hi"), {
      type: "attach_media",
      attachment: voice,
    });

    expect(
      applyServiceMessageEditorIntent(media, {
        type: "select_action",
        action: "reply_buttons",
        createDraftChoice: () => ({ id: "choice-1", label: "One" }),
      })
    ).toBe(media);
    expect(
      applyServiceMessageEditorIntent(media, {
        type: "select_action",
        action: "cta_url",
      })
    ).toBe(media);
    expect(
      applyServiceMessageEditorIntent(media, {
        type: "add_choice",
        option: { id: "choice-1", label: "One" },
      })
    ).toBe(media);

    const actions = getAvailableServiceMessageActions(media, {
      callingReady: true,
      hasWhatsAppCoexistence: false,
    });
    expect(actions).not.toContain("reply_buttons");
    expect(actions).not.toContain("cta_url");
    expect(actions).toContain("flow");
  });

  it("ignores audio attachments on interactive headers", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Pick" },
        options: [{ id: "choice-1", label: "One" }],
      },
    };
    const next = applyServiceMessageEditorIntent(value, {
      type: "attach_media",
      attachment: {
        url: "https://cdn.example/note.ogg",
        mediaType: "audio",
        mimeType: "audio/ogg",
        fileName: "note.ogg",
      },
    });
    expect(next).toBe(value);
  });

  it("does not mark non-OGG audio as a voice note", () => {
    const mp3 = {
      url: "https://cdn.example/track.mp3",
      mediaType: "audio" as const,
      mimeType: "audio/mpeg",
      fileName: "track.mp3",
    };
    const attached = applyServiceMessageEditorIntent(fixedText("Hi"), {
      type: "attach_media",
      attachment: mp3,
      deliverAsVoice: true,
    });
    expect(attached.message).toEqual({
      kind: "media",
      attachment: mp3,
      body: undefined,
    });
  });

  it("moves image media into an interactive header when adding reply buttons", () => {
    const media = applyServiceMessageEditorIntent(fixedText("Choose"), {
      type: "attach_media",
      attachment: image,
    });
    const result = applyServiceMessageEditorIntent(media, {
      type: "add_choice",
      option: { id: "choice-1", label: "First" },
    });

    expect(result.message).toEqual({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      header: { kind: "media", attachment: image },
      options: [{ id: "choice-1", label: "First" }],
    });
  });

  it("restores the underlying media when the action is removed", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        header: { kind: "media", attachment: image },
        options: [{ id: "choice-1", label: "First" }],
      },
    };

    expect(
      applyServiceMessageEditorIntent(value, { type: "remove_action" }).message
    ).toEqual({
      kind: "media",
      attachment: image,
      body: { mode: "fixed", text: "Choose" },
    });
  });

  it("restores text when direct media is removed", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "media",
        attachment: image,
        body: { mode: "fixed", text: "Caption" },
      },
    };

    expect(
      applyServiceMessageEditorIntent(value, { type: "remove_media" }).message
    ).toEqual({
      kind: "text",
      body: { mode: "fixed", text: "Caption" },
      previewUrl: true,
    });
  });

  it("removes the action when its final choice is deleted", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "choice-1", label: "First" }],
      },
    };

    expect(
      applyServiceMessageEditorIntent(value, {
        type: "remove_choice",
        optionId: "choice-1",
      }).message
    ).toEqual({
      kind: "text",
      body: { mode: "fixed", text: "Choose" },
      previewUrl: true,
    });
  });

  it("converts the fourth reply button to a list without changing option ids", () => {
    const body = { mode: "fixed" as const, text: "Choose" };
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body,
        footerText: "Footer",
        options: [
          { id: "choice-1", label: "One" },
          { id: "choice-2", label: "Two" },
          { id: "choice-3", label: "Three" },
        ],
      },
    };

    const result = applyServiceMessageEditorIntent(value, {
      type: "add_choice",
      option: { id: "choice-4", label: "Four" },
    });

    expect(result.message).toMatchObject({
      kind: "list",
      body,
      footerText: "Footer",
      sections: [
        {
          rows: [
            { id: "choice-1", title: "One" },
            { id: "choice-2", title: "Two" },
            { id: "choice-3", title: "Three" },
            { id: "choice-4", title: "Four" },
          ],
        },
      ],
    });
  });

  it("converts a simple list back to reply buttons at three rows", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [
          {
            id: "section-1",
            rows: [
              { id: "choice-1", title: "One" },
              { id: "choice-2", title: "Two" },
              { id: "choice-3", title: "Three" },
              { id: "choice-4", title: "Four" },
            ],
          },
        ],
      },
    };

    expect(
      applyServiceMessageEditorIntent(value, {
        type: "remove_choice",
        optionId: "choice-4",
      }).message
    ).toEqual({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      options: [
        { id: "choice-1", label: "One" },
        { id: "choice-2", label: "Two" },
        { id: "choice-3", label: "Three" },
      ],
    });
  });

  it("keeps rich lists as lists when rows are removed", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        headerText: "Products",
        buttonLabel: "Options",
        sections: [
          {
            id: "section-1",
            title: "Popular",
            rows: [
              { id: "choice-1", title: "One", description: "Details" },
              { id: "choice-2", title: "Two" },
            ],
          },
        ],
      },
    };

    expect(
      applyServiceMessageEditorIntent(value, {
        type: "remove_choice",
        optionId: "choice-2",
      }).message
    ).toMatchObject({
      kind: "list",
      headerText: "Products",
      sections: [
        {
          title: "Popular",
          rows: [{ id: "choice-1", title: "One", description: "Details" }],
        },
      ],
    });
  });

  it("refuses to add more than 10 list rows", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      id: `choice-${index + 1}`,
      title: `Row ${index + 1}`,
    }));
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [{ id: "section-1", rows }],
      },
    };

    expect(
      applyServiceMessageEditorIntent(value, {
        type: "add_choice",
        option: { id: "choice-11", label: "Overflow" },
      })
    ).toBe(value);
  });

  it("replaces the text message with native contact and location messages", () => {
    expect(
      applyServiceMessageEditorIntent(fixedText("Ignored"), {
        type: "select_action",
        action: "contacts",
      }).message.kind
    ).toBe("contacts");
    expect(
      applyServiceMessageEditorIntent(fixedText("Ignored"), {
        type: "select_action",
        action: "location",
      }).message.kind
    ).toBe("location");
  });

  it("gates unavailable calling and coexistence catalog actions", () => {
    const actions = getAvailableServiceMessageActions(fixedText("Hi"), {
      callingReady: false,
      hasWhatsAppCoexistence: true,
    });

    expect(actions).not.toContain("voice_call");
    expect(actions).not.toContain("commerce");
    expect(actions).toContain("request_contact_info");
    expect(actions).toContain("location_request");
  });

  it("no-ops re-selecting reply buttons and seeds a draft choice when needed", () => {
    const withChoice: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "choice-1", label: "One" }],
      },
    };
    const createDraftChoice = jest.fn(() => ({
      id: "choice-unused",
      label: "",
    }));
    expect(
      applyServiceMessageEditorIntent(withChoice, {
        type: "select_action",
        action: "reply_buttons",
        createDraftChoice,
      })
    ).toBe(withChoice);
    expect(createDraftChoice).not.toHaveBeenCalled();

    const fromText = applyServiceMessageEditorIntent(fixedText("Choose"), {
      type: "select_action",
      action: "reply_buttons",
      createDraftChoice: () => ({ id: "choice-new", label: "" }),
    });
    expect(fromText.message).toEqual({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      header: undefined,
      footerText: undefined,
      options: [{ id: "choice-new", label: "" }],
    });
  });

  it("preserves website label when switching back to reply buttons", () => {
    const website: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "cta_url",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Shop now",
        urlSource: { kind: "fixed", url: "https://example.com" },
        footerText: "Footer",
      },
    };

    expect(
      applyServiceMessageEditorIntent(website, {
        type: "select_action",
        action: "reply_buttons",
        createDraftChoice: () => ({ id: "choice-1", label: "" }),
      }).message
    ).toEqual({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      header: undefined,
      footerText: "Footer",
      options: [{ id: "choice-1", label: "Shop now" }],
    });
  });

  it("projects canonical editor behavior instead of making React reclassify the message", () => {
    const list: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [
          {
            id: "section-1",
            rows: Array.from({ length: 10 }, (_, index) => ({
              id: `choice-${index + 1}`,
              title: `Choice ${index + 1}`,
            })),
          },
        ],
      },
    };

    expect(
      projectServiceMessageEditor(list, {
        callingReady: true,
        hasWhatsAppCoexistence: false,
      })
    ).toMatchObject({
      action: "list",
      body: { mode: "fixed", text: "Choose" },
      media: null,
      tray: "interactive",
      allowsStandaloneAudio: false,
      supportsTextHeader: true,
      supportsFooter: true,
      supportsMedia: false,
      canAddChoice: false,
      isCarousel: false,
      supportsRenderer: true,
      currentActionAvailable: true,
      currentActionUnavailableReason: null,
    });

    const commerce: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "commerce",
        commerce: { mode: "catalog", catalogId: "catalog-1" },
      },
    };
    expect(
      projectServiceMessageEditor(commerce, {
        callingReady: true,
        hasWhatsAppCoexistence: true,
      })
    ).toMatchObject({
      tray: "commerce",
      supportsRenderer: false,
      currentActionAvailable: false,
      currentActionUnavailableReason: "coexistence_unsupported",
    });
  });

  it("uses one exhaustive registry for ordered action availability", () => {
    expect(SERVICE_MESSAGE_EDITOR_ACTIONS.map(item => item.action)).toEqual([
      "reply_buttons",
      "cta_url",
      "flow",
      "appointment",
      "voice_call",
      "media_carousel",
      "commerce",
      "contacts",
      "request_contact_info",
      "location",
      "location_request",
    ]);
    expect(
      getAvailableServiceMessageActions(fixedText("Hi"), {
        callingReady: false,
        hasWhatsAppCoexistence: true,
      })
    ).toEqual([
      "reply_buttons",
      "cta_url",
      "flow",
      "appointment",
      "media_carousel",
      "contacts",
      "request_contact_info",
      "location",
      "location_request",
    ]);
  });

  it("seeds carousel cards atomically and does not allocate on a same-family pick", () => {
    const createCarouselCards = jest.fn(() => [
      {
        id: "card-1",
        media: { url: "", mediaType: "image" as const },
        interaction: {
          kind: "quick_replies" as const,
          options: [{ id: "choice-1", label: "" }],
        },
      },
      {
        id: "card-2",
        media: { url: "", mediaType: "image" as const },
        interaction: {
          kind: "quick_replies" as const,
          options: [{ id: "choice-2", label: "" }],
        },
      },
    ]);
    const carousel = applyServiceMessageEditorIntent(fixedText("Browse"), {
      type: "select_action",
      action: "media_carousel",
      createCarouselCards,
    });

    expect(createCarouselCards).toHaveBeenCalledTimes(1);
    expect(carousel.message).toMatchObject({
      kind: "media_carousel",
      cards: [{ id: "card-1" }, { id: "card-2" }],
    });

    expect(
      applyServiceMessageEditorIntent(carousel, {
        type: "select_action",
        action: "media_carousel",
        createCarouselCards,
      })
    ).toBe(carousel);
    expect(createCarouselCards).toHaveBeenCalledTimes(1);
  });

  it("preserves meaningful header and footer whitespace while trimming only emptiness", () => {
    const value: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "reply_buttons",
        body: { mode: "fixed", text: "Choose" },
        options: [{ id: "choice-1", label: "" }],
      },
    };
    const withHeader = applyServiceMessageEditorIntent(value, {
      type: "set_header_text",
      value: "Summer sale ",
    });
    expect(withHeader.message).toMatchObject({
      header: { kind: "text", text: "Summer sale " },
    });
    const withFooter = applyServiceMessageEditorIntent(withHeader, {
      type: "set_footer_text",
      value: "Terms apply ",
    });
    expect(withFooter.message).toMatchObject({
      footerText: "Terms apply ",
    });
    expect(
      applyServiceMessageEditorIntent(withFooter, {
        type: "set_footer_text",
        value: "   ",
      }).message
    ).not.toHaveProperty("footerText");
  });

  it.each(["set_header_text", "set_footer_text"] as const)(
    "does not create reply buttons through %s",
    type => {
      const value = fixedText("Choose");
      expect(
        applyServiceMessageEditorIntent(value, { type, value: "Note" })
      ).toBe(value);
      expect(applyServiceMessageEditorIntent(value, { type, value: "" })).toBe(
        value
      );
    }
  );

  it("removes list sections through the same invariant-preserving transition owner", () => {
    const onlySection: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [
          {
            id: "section-1",
            title: "Featured",
            rows: [{ id: "choice-1", title: "One" }],
          },
        ],
      },
    };
    expect(
      applyServiceMessageEditorIntent(onlySection, {
        type: "remove_list_section",
        sectionId: "section-1",
      }).message
    ).toEqual({
      kind: "text",
      body: { mode: "fixed", text: "Choose" },
      previewUrl: true,
    });

    const twoSections: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [
          {
            id: "rich",
            title: "Featured",
            rows: [{ id: "choice-1", title: "One" }],
          },
          {
            id: "simple",
            rows: [
              { id: "choice-2", title: "Two" },
              { id: "choice-3", title: "Three" },
            ],
          },
        ],
      },
    };
    expect(
      applyServiceMessageEditorIntent(twoSections, {
        type: "remove_list_section",
        sectionId: "rich",
      }).message
    ).toEqual({
      kind: "reply_buttons",
      body: { mode: "fixed", text: "Choose" },
      options: [
        { id: "choice-2", label: "Two" },
        { id: "choice-3", label: "Three" },
      ],
    });
  });

  it("owns list section and row additions and enforces their capacity", () => {
    const list: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [{ id: "section-1", rows: [] }],
      },
    };
    const withRow = applyServiceMessageEditorIntent(list, {
      type: "add_list_row",
      sectionId: "section-1",
      row: { id: "choice-1", title: "" },
    });
    expect(withRow.message).toMatchObject({
      kind: "list",
      sections: [{ rows: [{ id: "choice-1" }] }],
    });
    expect(
      applyServiceMessageEditorIntent(withRow, {
        type: "add_list_section",
        section: { id: "section-2", rows: [] },
      }).message
    ).toMatchObject({
      kind: "list",
      sections: [{ id: "section-1" }, { id: "section-2" }],
    });

    const atRowLimit: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: [
          {
            id: "section-1",
            rows: Array.from({ length: 10 }, (_, index) => ({
              id: `choice-${index}`,
              title: `Choice ${index}`,
            })),
          },
        ],
      },
    };
    expect(
      applyServiceMessageEditorIntent(atRowLimit, {
        type: "add_list_row",
        sectionId: "section-1",
        row: { id: "overflow", title: "" },
      })
    ).toBe(atRowLimit);

    const atSectionLimit: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "Choose" },
        buttonLabel: "Options",
        sections: Array.from({ length: 10 }, (_, index) => ({
          id: `section-${index}`,
          rows: [{ id: `choice-${index}`, title: `Choice ${index}` }],
        })),
      },
    };
    expect(
      applyServiceMessageEditorIntent(atSectionLimit, {
        type: "add_list_section",
        section: { id: "overflow", rows: [] },
      })
    ).toBe(atSectionLimit);
  });
});
