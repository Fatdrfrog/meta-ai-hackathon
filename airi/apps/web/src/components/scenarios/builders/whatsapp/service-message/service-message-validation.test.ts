import {
  createDefaultScenarioWhatsAppServiceMessage,
  SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS,
  type ScenarioWhatsAppServiceMessage,
} from "@icecore/scenario-contracts";
import {
  getServiceMessageValidationDiagnostics,
  serviceMessageDiagnosticMessageKey,
  serviceMessageDiagnosticMessageValues,
} from "./service-message-validation";

describe("service-message editor validation", () => {
  it("reports missing plain text bodies for runnable validation", () => {
    expect(
      getServiceMessageValidationDiagnostics({
        version: 1,
        message: {
          kind: "text",
          body: { mode: "fixed", text: "" },
          previewUrl: true,
        },
      }).some(diagnostic => diagnostic.code === "body_required")
    ).toBe(true);

    expect(
      getServiceMessageValidationDiagnostics({
        version: 1,
        message: {
          kind: "reply_buttons",
          body: { mode: "fixed", text: "" },
          options: [],
        },
      }).some(diagnostic => diagnostic.code === "body_required")
    ).toBe(true);
  });

  it("preserves optional captions for valid media messages", () => {
    expect(
      getServiceMessageValidationDiagnostics({
        version: 1,
        message: {
          kind: "media",
          attachment: { url: "https://cdn.test/photo.jpg", mediaType: "image" },
        },
      })
    ).toEqual([]);
  });

  it.each([
    ["appointment_invalid", "whatsappServiceValidationAppointment"],
    ["commerce_invalid", "whatsappServiceValidationCommerce"],
    ["list_section_count_invalid", "whatsappServiceValidationListSections"],
    ["list_row_count_invalid", "whatsappServiceValidationListRows"],
    ["list_section_title_too_long", "whatsappServiceValidationListTextTooLong"],
    ["list_row_title_too_long", "whatsappServiceValidationListTextTooLong"],
    [
      "list_row_description_too_long",
      "whatsappServiceValidationListTextTooLong",
    ],
    ["voice_call_ttl_invalid", "whatsappServiceValidationCallTtl"],
  ] as const)("names the fix for %s", (code, key) => {
    expect(serviceMessageDiagnosticMessageKey(code)).toBe(key);
  });

  it("falls back to the generic message for codes without a field", () => {
    expect(serviceMessageDiagnosticMessageKey("managed_url_unresolved")).toBe(
      "whatsappServiceMessageInvalid"
    );
  });

  it("gives a too-long body the limit of the field it is in", () => {
    const text = {
      version: 1 as const,
      message: {
        kind: "text" as const,
        body: { mode: "fixed" as const, text: "" },
      },
    };
    const buttons = {
      version: 1 as const,
      message: {
        kind: "reply_buttons" as const,
        body: { mode: "fixed" as const, text: "" },
        options: [],
      },
    };
    expect(
      serviceMessageDiagnosticMessageValues("body_too_long", "body", text)
    ).toEqual({ max: 4096 });
    expect(
      serviceMessageDiagnosticMessageValues("body_too_long", "body", buttons)
    ).toEqual({ max: 1024 });
    // The contract gives a list body the text limit, not the interactive one.
    const list = {
      version: 1 as const,
      message: {
        kind: "list" as const,
        body: { mode: "fixed" as const, text: "" },
        buttonLabel: "Menu",
        sections: [],
      },
    };
    expect(
      serviceMessageDiagnosticMessageValues("body_too_long", "body", list)
    ).toEqual({ max: 4096 });
    expect(
      serviceMessageDiagnosticMessageValues(
        "body_too_long",
        "cards.1.bodyText",
        buttons
      )
    ).toEqual({ max: 160 });
    expect(
      serviceMessageDiagnosticMessageValues("body_required", "body", text)
    ).toBeUndefined();
  });

  it.each(
    SCENARIO_WHATSAPP_SERVICE_MESSAGE_KINDS.filter(
      kind =>
        "body" in createDefaultScenarioWhatsAppServiceMessage(kind).message
    )
  )("names the body limit the contract applies to %s", kind => {
    const base = createDefaultScenarioWhatsAppServiceMessage(kind);
    const withBody = (length: number) =>
      ({
        ...base,
        message: {
          ...base.message,
          body: { mode: "fixed", text: "x".repeat(length) },
        },
      }) as ScenarioWhatsAppServiceMessage;
    const bodyTooLong = (length: number) =>
      getServiceMessageValidationDiagnostics(withBody(length)).some(
        diagnostic =>
          diagnostic.code === "body_too_long" &&
          diagnostic.path === "message.body"
      );
    const max = serviceMessageDiagnosticMessageValues(
      "body_too_long",
      "body",
      base
    )?.max;
    expect(max).toEqual(expect.any(Number));
    expect(bodyTooLong(max!)).toBe(false);
    expect(bodyTooLong(max! + 1)).toBe(true);
  });
});
