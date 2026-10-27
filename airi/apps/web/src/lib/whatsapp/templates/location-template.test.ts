import { parseWhatsAppTemplateSubmissionComponents } from "./component-schemas";
import {
  buildWhatsAppTemplateSendComponentsFromTemplate,
  normalizeWhatsAppTemplateSendComponents,
} from "./message-types";
import { createTemplate } from "./service";

const mockPostJson = jest.fn(async (..._args: unknown[]) => ({
  messages: [{ id: "wamid.location" }],
}));
jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
  MetaGraphRequestError: class extends Error {},
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: jest.fn(() => {
    throw new Error("Cookies unavailable");
  }),
}));
jest.mock("@/lib/mongoose", () => ({ connectDB: jest.fn() }));
jest.mock("@/lib/observability/server-logs", () => ({
  createServerLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));
jest.mock("@/models/whatsapp-template", () => ({
  WhatsAppTemplateAuditLog: {},
  WhatsAppTemplateModel: {},
}));

const location = {
  latitude: 43.238949,
  longitude: 76.889709,
  name: "Sample pickup point",
  address: "Fictional demo at a public landmark",
};
const templateComponents = [
  { type: "HEADER", format: "LOCATION" },
  { type: "BODY", text: "Your sample pickup is ready." },
] as never;
const accountContext = {
  workspaceId: "workspace-1",
  sourceId: "source-selected",
  wabaId: "waba-selected",
  accessToken: "operator-token",
  candidateSource: "credentials.waba_id" as const,
};

it("accepts a native location header without uploading review media", async () => {
  const parsed = parseWhatsAppTemplateSubmissionComponents(templateComponents);
  expect(parsed.success).toBe(true);
  const mockFetch = jest.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: "meta-location", status: "PENDING" }))
  );
  global.fetch = mockFetch;
  await expect(
    createTemplate(
      "workspace-1",
      {
        name: "airi_demo_pickup",
        language: "en",
        category: "MARKETING",
        components: templateComponents,
      },
      { accountContext }
    )
  ).resolves.toMatchObject({ id: "meta-location" });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(mockFetch.mock.calls[0][1]?.body as string).components
  ).toEqual(templateComponents);
});

it("builds and sends the native location template parameter through the canonical sender", async () => {
  const built = buildWhatsAppTemplateSendComponentsFromTemplate({
    templateComponents,
    headerLocation: location,
  });
  expect(built.issues).toEqual([]);
  expect(built.components).toEqual([
    { type: "header", parameters: [{ type: "location", location }] },
  ]);
  const { sendWhatsappTemplate } = await import("@/lib/whatsapp");
  await sendWhatsappTemplate(
    "phone-1",
    "operator-token",
    "77001234567",
    "airi_demo_pickup",
    "en",
    built.components
  );
  expect(mockPostJson).toHaveBeenCalledWith(
    "phone-1/messages",
    expect.objectContaining({
      body: expect.objectContaining({
        type: "template",
        template: expect.objectContaining({ components: built.components }),
      }),
    })
  );
});

it("reports missing fixed location parameters instead of silently producing a sendable header", () => {
  expect(
    buildWhatsAppTemplateSendComponentsFromTemplate({ templateComponents })
      .issues
  ).toContainEqual({ type: "missing_header_location", format: "LOCATION" });
});

it.each([
  { ...location, latitude: 91 },
  { ...location, longitude: -181 },
  { ...location, latitude: Number.NaN },
  { ...location, latitude: "" },
])("rejects malformed template coordinates before sending", value => {
  expect(() =>
    normalizeWhatsAppTemplateSendComponents([
      { type: "header", parameters: [{ type: "location", location: value }] },
    ] as never)
  ).toThrow("Invalid WhatsApp template location");
});
