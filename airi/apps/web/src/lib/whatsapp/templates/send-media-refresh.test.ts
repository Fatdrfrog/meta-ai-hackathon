const mockListTemplates = jest.fn();
jest.mock("./service", () => ({
  listTemplates: (...args: unknown[]) => mockListTemplates(...args),
}));
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/whatsapp-template", () => ({ WhatsAppTemplateModel: {} }));

import { refreshWhatsAppTemplateMediaForSend } from "./send-lookup";
import type { WhatsAppTemplateSendComponentInput } from "./message-types";

const oldUrl = "https://scontent.whatsapp.net/v/video.mp4?oe=old&oh=old";
const freshUrl = "https://scontent.whatsapp.net/v/video.mp4?oe=new&oh=new";
const source = { from: jest.fn() };
const components: WhatsAppTemplateSendComponentInput[] = [
  { type: "header", parameters: [{ type: "video", video: { link: oldUrl } }] },
  { type: "body", parameters: [{ type: "text", text: "Customer value" }] },
];
const input = {
  workspaceId: "workspace",
  sourceId: "source",
  expectedWabaId: "waba",
  templateName: "followup",
  languageCode: "kz",
  components,
  supabase: source,
};
function catalog(overrides = {}) {
  return {
    templates: [
      {
        id: "template",
        name: "followup",
        status: "APPROVED",
        language: "kk",
        category: "MARKETING",
        components: [
          {
            type: "HEADER",
            format: "VIDEO",
            example: { header_handle: [freshUrl] },
          },
        ],
      },
    ],
    catalog: {
      source: "live",
      stale: false,
      fetchedAt: new Date().toISOString(),
      wabaId: "waba",
      refreshOutcome: "succeeded",
      retryAt: null,
      ...overrides,
    },
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockListTemplates.mockResolvedValue(catalog());
});

it("refreshes only the sample media at the delivery boundary using the exact account", async () => {
  const result = await refreshWhatsAppTemplateMediaForSend(input);
  expect(result?.[0]).toEqual({
    type: "header",
    parameters: [{ type: "video", video: { link: freshUrl } }],
  });
  expect(result?.[1]).toBe(components[1]);
  expect(components[0]).toEqual({
    type: "header",
    parameters: [{ type: "video", video: { link: oldUrl } }],
  });
  expect(mockListTemplates).toHaveBeenCalledWith("workspace", {
    status: "APPROVED",
    sourceId: "source",
    supabase: source,
  });
});
it.each([{ stale: true }, { wabaId: "another-waba" }])(
  "rejects unverifiable media instead of returning the expired snapshot: %j",
  async metadata => {
    mockListTemplates.mockResolvedValue(catalog(metadata));
    await expect(refreshWhatsAppTemplateMediaForSend(input)).rejects.toThrow();
  }
);
it("does not turn a failed refresh into a send using old media", async () => {
  mockListTemplates.mockRejectedValue(new Error("provider unavailable"));
  await expect(refreshWhatsAppTemplateMediaForSend(input)).rejects.toThrow(
    "provider unavailable"
  );
});
it("preserves explicit custom media and does not refresh owned URLs or IDs", async () => {
  const own: WhatsAppTemplateSendComponentInput[] = [
    {
      type: "header",
      parameters: [
        {
          type: "video",
          video: { link: "https://media.airi.chat/original.mp4" },
        },
      ],
    },
  ];
  expect(
    await refreshWhatsAppTemplateMediaForSend({ ...input, components: own })
  ).toBe(own);
  expect(mockListTemplates).not.toHaveBeenCalled();
  const custom: WhatsAppTemplateSendComponentInput[] = [
    {
      type: "header",
      parameters: [
        {
          type: "video",
          video: {
            link: "https://scontent.whatsapp.net/v/custom.mp4?oe=other",
          },
        },
      ],
    },
  ];
  expect(
    await refreshWhatsAppTemplateMediaForSend({ ...input, components: custom })
  ).toEqual(custom);
});
it("refreshes matching carousel card media and preserves other card parameters", async () => {
  const result = catalog();
  const header = result.templates[0].components[0];
  result.templates[0].components = [
    { type: "CAROUSEL", cards: [{ components: [header] }] },
  ] as never;
  mockListTemplates.mockResolvedValue(result);
  const cards: WhatsAppTemplateSendComponentInput[] = [
    { type: "carousel", cards: [{ card_index: 0, components }] },
  ];
  expect(
    await refreshWhatsAppTemplateMediaForSend({ ...input, components: cards })
  ).toEqual([
    {
      type: "carousel",
      cards: [
        {
          card_index: 0,
          components: [
            {
              type: "header",
              parameters: [{ type: "video", video: { link: freshUrl } }],
            },
            components[1],
          ],
        },
      ],
    },
  ]);
});
it("allows one explicit refresh without bypassing the canonical catalog policy", async () => {
  await refreshWhatsAppTemplateMediaForSend({ ...input, force: true });
  expect(mockListTemplates).toHaveBeenCalledWith(
    "workspace",
    expect.objectContaining({ force: true })
  );
});

it("uses authoritative account media for an explicitly identified template default", async () => {
  const result = catalog();
  result.templates[0].components[0].example.header_handle = [
    "https://scontent.whatsapp.net/v/current-account.mp4?oe=fresh",
  ];
  mockListTemplates.mockResolvedValue(result);
  expect(
    await refreshWhatsAppTemplateMediaForSend({
      ...input,
      useTemplateMedia: true,
    })
  ).toMatchObject([
    {
      type: "header",
      parameters: [
        {
          video: {
            link: "https://scontent.whatsapp.net/v/current-account.mp4?oe=fresh",
          },
        },
      ],
    },
    {},
  ]);
});
it("blocks an unproven legacy scenario sample from another account instead of treating it as custom media", async () => {
  const result = catalog();
  result.templates[0].components[0].example.header_handle = [
    "https://scontent.whatsapp.net/v/another-account.mp4?oe=fresh",
  ];
  mockListTemplates.mockResolvedValue(result);
  await expect(
    refreshWhatsAppTemplateMediaForSend({
      ...input,
      requireMatchingSample: true,
    })
  ).rejects.toThrow();
});
it("blocks changed header formats rather than sending an old cached sample", async () => {
  const result = catalog();
  result.templates[0].components[0].format = "IMAGE";
  mockListTemplates.mockResolvedValue(result);
  await expect(
    refreshWhatsAppTemplateMediaForSend({ ...input, useTemplateMedia: true })
  ).rejects.toThrow();
});
