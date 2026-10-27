import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDefaultScenarioWhatsAppServiceMessage,
  extractScenarioWhatsAppServiceBranchOptions,
  findScenarioWhatsAppServiceOption,
  listScenarioWhatsAppServiceOptions,
  normalizeScenarioWhatsAppServiceMessage,
  SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS,
  validateScenarioWhatsAppServiceMessage,
  type ScenarioWhatsAppServiceMessage,
} from "./whatsapp-service-message.ts";
import { compileWhatsAppServiceMessage } from "./whatsapp-service-message-compiler.ts";

const body = { mode: "fixed", text: "" };

describe("WhatsApp service message draft parsing", () => {
  for (const value of [
    undefined,
    null,
    "",
    "   ",
    false,
    [],
    {},
    "north",
    91,
  ]) {
    it(`rejects unfinished or invalid location coordinates when runnable: ${JSON.stringify(value)}`, () => {
      const draft = {
        version: 1,
        message: {
          kind: "location",
          location: { version: 1, latitude: value, longitude: 0 },
        },
      };
      assert.equal(
        normalizeScenarioWhatsAppServiceMessage(draft).status,
        "supported",
      );
      assert.deepEqual(validateScenarioWhatsAppServiceMessage(draft), [
        { code: "location_coordinates_invalid", path: "message.location" },
      ]);
    });
  }

  for (const coordinate of [0, "0", " 0 ", "12.5"]) {
    it(`accepts a provided location coordinate: ${JSON.stringify(coordinate)}`, () => {
      assert.deepEqual(
        validateScenarioWhatsAppServiceMessage({
          version: 1,
          message: {
            kind: "location",
            location: {
              version: 1,
              latitude: coordinate,
              longitude: coordinate,
            },
          },
        }),
        [],
      );
    });
  }

  it("keeps every editable default without applying runnable validation", () => {
    for (const kind of SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS) {
      const draft = createDefaultScenarioWhatsAppServiceMessage(kind);
      const result = normalizeScenarioWhatsAppServiceMessage(draft);
      assert.equal(result.status, "supported", kind);
      if (result.status !== "supported") continue;
      assert.equal(result.value, draft);
      assert.deepEqual(JSON.parse(JSON.stringify(result.value)), draft);
      assert.equal(
        validateScenarioWhatsAppServiceMessage(draft).some(
          (diagnostic) => diagnostic.code === "message_kind_invalid",
        ),
        false,
        kind,
      );
    }
    assert.deepEqual(
      validateScenarioWhatsAppServiceMessage(
        createDefaultScenarioWhatsAppServiceMessage("reply_buttons"),
      ).map((diagnostic) => diagnostic.code),
      ["body_required", "reply_button_count_invalid"],
    );
  });

  const malformedMessages = [
    { name: "missing body", message: { kind: "text" } },
    { name: "scalar body", message: { kind: "text", body: "draft" } },
    { name: "missing media", message: { kind: "media", body } },
    { name: "missing options", message: { kind: "reply_buttons", body } },
    {
      name: "null options",
      message: { kind: "reply_buttons", body, options: null },
    },
    { name: "missing sections", message: { kind: "list", body } },
    {
      name: "scalar sections",
      message: { kind: "list", body, sections: "draft" },
    },
    {
      name: "missing section rows",
      message: { kind: "list", body, sections: [{ id: "section" }] },
    },
    { name: "missing URL source", message: { kind: "cta_url", body } },
    {
      name: "missing header media",
      message: {
        kind: "reply_buttons",
        body,
        options: [],
        header: { kind: "media" },
      },
    },
    { name: "missing cards", message: { kind: "media_carousel", body } },
    {
      name: "scalar cards",
      message: { kind: "media_carousel", body, cards: "draft" },
    },
    {
      name: "missing card media",
      message: {
        kind: "media_carousel",
        body,
        cards: [{ id: "card", interaction: { kind: "url" } }],
      },
    },
    {
      name: "missing card options",
      message: {
        kind: "media_carousel",
        body,
        cards: [
          {
            id: "card",
            media: { url: "", mediaType: "image" },
            interaction: { kind: "quick_replies" },
          },
        ],
      },
    },
    { name: "missing Flow config", message: { kind: "flow", body } },
    {
      name: "missing Flow screens",
      message: { kind: "flow", body, flowConfig: {} },
    },
    {
      name: "missing Flow fields",
      message: {
        kind: "flow",
        body,
        flowConfig: { screens: [{ id: "SCREEN" }] },
      },
    },
    {
      name: "missing appointment config",
      message: { kind: "appointment", body },
    },
    { name: "missing contacts", message: { kind: "contacts" } },
    { name: "null location", message: { kind: "location", location: null } },
    { name: "missing commerce config", message: { kind: "commerce" } },
    {
      name: "missing product sections",
      message: { kind: "commerce", commerce: { mode: "multi_product" } },
    },
    {
      name: "missing section product ids",
      message: {
        kind: "commerce",
        commerce: { mode: "multi_product", sections: [{ id: "section" }] },
      },
    },
  ];

  for (const { name, message } of malformedMessages) {
    it(`does not expose ${name} as an editable typed draft`, () => {
      const raw = { version: 1, message, futureData: { keep: true } };
      const snapshot = JSON.stringify(raw);
      assert.equal(
        normalizeScenarioWhatsAppServiceMessage(raw).status,
        "invalid",
      );
      assert.deepEqual(validateScenarioWhatsAppServiceMessage(raw), [
        { code: "message_kind_invalid", path: "message" },
      ]);
      assert.equal(JSON.stringify(raw), snapshot);
    });
  }

  it("rejects nonnumeric versions without coercing or rewriting raw data", () => {
    for (const version of [
      "1",
      true,
      [1],
      {},
      null,
      undefined,
      NaN,
      Infinity,
    ]) {
      const raw = { version, message: { kind: "text", body } };
      assert.equal(
        normalizeScenarioWhatsAppServiceMessage(raw).status,
        "invalid",
      );
      assert.equal(raw.version, version);
    }
  });

  it("keeps unsupported numeric versions opaque", () => {
    const raw = {
      version: 2,
      message: { kind: "future_kind", opaque: [1, 2] },
    };
    const snapshot = JSON.stringify(raw);
    assert.deepEqual(normalizeScenarioWhatsAppServiceMessage(raw), {
      status: "unsupported_version",
      version: 2,
    });
    assert.equal(JSON.stringify(raw), snapshot);
  });

  it("preserves unfinished nested rows and authored whitespace", () => {
    const draft = {
      version: 1,
      message: {
        kind: "list",
        body: { mode: "fixed", text: "  Still editing  " },
        buttonLabel: "",
        sections: [
          { id: "section", title: "", rows: [{ id: "row", title: "" }] },
        ],
      },
      futureData: { keep: true },
    };
    const result = normalizeScenarioWhatsAppServiceMessage(draft);
    assert.equal(result.status, "supported");
    if (result.status !== "supported") return;
    assert.equal(result.value, draft);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), draft);
    assert.equal(
      validateScenarioWhatsAppServiceMessage(result.value).length > 0,
      true,
    );
  });

  it("keeps empty nested Flow, carousel, and commerce controls editable", () => {
    const messages = [
      {
        kind: "flow",
        body,
        flowConfig: {
          templateId: "",
          ctaText: "",
          screens: [{ id: "SCREEN", title: "", fields: [] }],
        },
      },
      {
        kind: "media_carousel",
        body,
        cards: [
          {
            id: "card",
            media: { url: "", mediaType: "image" },
            interaction: { kind: "quick_replies", options: [] },
          },
        ],
      },
      {
        kind: "commerce",
        commerce: {
          mode: "multi_product",
          catalogId: "",
          headerText: "",
          bodyText: "",
          sections: [{ id: "section", title: "", productRetailerIds: [] }],
        },
      },
    ];
    for (const message of messages) {
      const draft = { version: 1, message };
      const result = normalizeScenarioWhatsAppServiceMessage(draft);
      assert.equal(result.status, "supported", message.kind);
      if (result.status !== "supported") continue;
      assert.equal(result.value, draft);
      const diagnostics = validateScenarioWhatsAppServiceMessage(result.value);
      assert.equal(diagnostics.length > 0, true);
      assert.equal(
        diagnostics.some((item) => item.code === "message_kind_invalid"),
        false,
      );
    }
  });
});

describe("WhatsApp service message options", () => {
  const cardMedia = (name: string) => ({
    url: `gcs://media/workspaces/w1/creative-assets/image/${name}`,
    mediaType: "image" as const,
    mimeType: "image/jpeg",
    fileSize: 2048,
    bucket: "media",
    path: `workspaces/w1/creative-assets/image/${name}`,
  });
  const carousel: ScenarioWhatsAppServiceMessage = {
    version: 1,
    message: {
      kind: "media_carousel",
      body: { mode: "fixed", text: "Pick a medal holder" },
      cards: [
        {
          id: "card-gold",
          media: cardMedia("gold.jpg"),
          bodyText: " Gold frame ",
          interaction: {
            kind: "quick_replies",
            options: [
              { id: " wsc:node-1:gold-buy ", label: " Buy " },
              { id: "wsc:node-1:gold-info", label: "" },
            ],
          },
        },
        {
          id: "card-silver",
          media: cardMedia("silver.jpg"),
          interaction: {
            kind: "quick_replies",
            options: [
              { id: "wsc:node-1:silver-buy", label: "Buy" },
              { id: "  ", label: "Draft" },
            ],
          },
        },
      ],
    },
  };

  it("keeps the card each carousel option came from", () => {
    assert.deepEqual(listScenarioWhatsAppServiceOptions(carousel), [
      {
        id: "wsc:node-1:gold-buy",
        label: "Buy",
        cardIndex: 0,
        cardId: "card-gold",
        cardMedia: cardMedia("gold.jpg"),
        cardBodyText: "Gold frame",
      },
      {
        id: "wsc:node-1:gold-info",
        label: "",
        cardIndex: 0,
        cardId: "card-gold",
        cardMedia: cardMedia("gold.jpg"),
        cardBodyText: "Gold frame",
      },
      {
        id: "wsc:node-1:silver-buy",
        label: "Buy",
        cardIndex: 1,
        cardId: "card-silver",
        cardMedia: cardMedia("silver.jpg"),
      },
    ]);
  });

  it("still flattens branch options with the id standing in for a missing label", () => {
    assert.deepEqual(
      extractScenarioWhatsAppServiceBranchOptions({ config: carousel }),
      [
        { id: "wsc:node-1:gold-buy", label: "Buy" },
        { id: "wsc:node-1:gold-info", label: "wsc:node-1:gold-info" },
        { id: "wsc:node-1:silver-buy", label: "Buy" },
      ],
    );
  });

  it("lists reply buttons and list rows without a card", () => {
    assert.deepEqual(
      listScenarioWhatsAppServiceOptions({
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "Choose" },
          options: [{ id: "yes", label: "Yes" }],
        },
      }),
      [{ id: "yes", label: "Yes" }],
    );
    assert.deepEqual(
      listScenarioWhatsAppServiceOptions({
        version: 1,
        message: {
          kind: "list",
          body: { mode: "fixed", text: "Choose" },
          buttonLabel: "Open",
          sections: [
            { id: "s", rows: [{ id: "row", title: "Row", description: "d" }] },
          ],
        },
      }),
      [{ id: "row", label: "Row" }],
    );
  });

  it("finds a tapped option and its card in the node config and in the stored preview", () => {
    const sendable: ScenarioWhatsAppServiceMessage = {
      version: 1,
      message: {
        kind: "media_carousel",
        body: { mode: "fixed", text: "Pick a medal holder" },
        cards: [
          {
            id: "card-gold",
            media: cardMedia("gold.jpg"),
            bodyText: "Gold frame",
            interaction: {
              kind: "quick_replies",
              options: [{ id: "wsc:node-1:gold-buy", label: "Buy" }],
            },
          },
          {
            id: "card-silver",
            media: cardMedia("silver.jpg"),
            interaction: {
              kind: "quick_replies",
              options: [{ id: "wsc:node-1:silver-buy", label: "Buy" }],
            },
          },
        ],
      },
    };
    const compiled = compileWhatsAppServiceMessage({
      config: sendable,
      recipientKind: "phone",
    });
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    // As read back from the outbound message's `whatsappServiceMessage`.
    const stored = JSON.parse(JSON.stringify(compiled.preview));
    for (const source of [sendable, compiled.preview, stored]) {
      assert.deepEqual(
        findScenarioWhatsAppServiceOption(source, "wsc:node-1:silver-buy"),
        {
          id: "wsc:node-1:silver-buy",
          label: "Buy",
          cardIndex: 1,
          cardId: "card-silver",
          cardMedia: cardMedia("silver.jpg"),
        },
      );
    }
    assert.equal(
      findScenarioWhatsAppServiceOption(stored, " wsc:node-1:gold-buy ")
        ?.cardBodyText,
      "Gold frame",
    );
    for (const optionId of ["wsc:node-1:missing", "", null, undefined]) {
      assert.equal(findScenarioWhatsAppServiceOption(stored, optionId), null);
    }
    // Reply buttons and list rows have no card.
    assert.deepEqual(
      findScenarioWhatsAppServiceOption(
        {
          version: 1,
          kind: "reply_buttons",
          command: {
            kind: "reply_buttons",
            body: "Choose",
            options: [{ id: "yes", label: "Yes" }],
          },
        },
        "yes",
      ),
      { id: "yes", label: "Yes" },
    );
    assert.deepEqual(
      findScenarioWhatsAppServiceOption(
        {
          version: 1,
          message: {
            kind: "list",
            body: { mode: "fixed", text: "Choose" },
            buttonLabel: "Open",
            sections: [{ id: "s", rows: [{ id: "row", title: "Row" }] }],
          },
        },
        "row",
      ),
      { id: "row", label: "Row" },
    );
    for (const source of [
      null,
      undefined,
      { version: 1, kind: "media_carousel" },
    ]) {
      assert.equal(
        findScenarioWhatsAppServiceOption(source, "wsc:node-1:silver-buy"),
        null,
      );
    }
  });
});
