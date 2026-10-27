import {
  PUBLIC_TEMPLATE_CONSENT_VERSION,
  publicTemplateRequestBodySchema,
  publicTemplateReadinessSchema,
} from "./template-request";

const valid = {
  templateId: "welcome",
  locale: "en",
  name: " Sam ",
  email: "sam@company.com",
  phone: "+7 (700) 123-45-67",
  consent: true,
  consentVersion: PUBLIC_TEMPLATE_CONSENT_VERSION,
  requestId: "35f5218c-5d38-4d2a-87d0-f2ac0206a1fd",
  source: "marketplace",
};

describe("public readiness contract", () => {
  it("accepts disjoint ready and temporarily unavailable catalog IDs", () => {
    expect(
      publicTemplateReadinessSchema.parse({
        readyTemplateIds: ["welcome"],
        unavailableTemplateIds: ["appointment-booking"],
      })
    ).toEqual({
      readyTemplateIds: ["welcome"],
      unavailableTemplateIds: ["appointment-booking"],
    });
  });

  it.each([
    { readyTemplateIds: ["private-template"], unavailableTemplateIds: [] },
    { readyTemplateIds: ["welcome", "welcome"], unavailableTemplateIds: [] },
    { readyTemplateIds: ["welcome"], unavailableTemplateIds: ["welcome"] },
    { readyTemplateIds: [], unavailableTemplateIds: ["welcome", "welcome"] },
    { readyTemplateIds: ["welcome"] },
    { readyTemplateIds: [], unavailableTemplateIds: [], extra: true },
  ])("rejects unknown, ambiguous or incomplete readiness: %j", value => {
    expect(publicTemplateReadinessSchema.safeParse(value).success).toBe(false);
  });
});

it("normalizes visitor details and an explicit international phone", () => {
  expect(PUBLIC_TEMPLATE_CONSENT_VERSION).toBe(
    "public-template-demo-marketing-v2"
  );
  expect(publicTemplateRequestBodySchema.parse(valid)).toMatchObject({
    name: "Sam",
    phone: "+77001234567",
    website: "",
    consentVersion: PUBLIC_TEMPLATE_CONSENT_VERSION,
  });
});

it.each([
  { consent: false },
  { consentVersion: undefined },
  { consentVersion: "public-template-demo-v1" },
  { consentVersion: "unrecognized-consent" },
  { phone: "87001234567" },
  { phone: "+0123456789" },
  { phone: "+123456" },
  { phone: "+1234567890123456" },
  { name: " " },
  { email: "invalid" },
  { locale: "fr" },
  { source: "unknown" },
  { requestId: "same-request" },
  { templateName: "client_chosen_template" },
])("rejects invalid input and client-controlled send fields: %j", fields => {
  expect(
    publicTemplateRequestBodySchema.safeParse({ ...valid, ...fields }).success
  ).toBe(false);
});
