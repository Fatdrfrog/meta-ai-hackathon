import { attributeMetaCredentialOwner } from "@/lib/meta/credential-owner";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { classifyWhatsAppMetaDiagnosticError } from "./whatsapp-diagnostics";

describe("WhatsApp Meta diagnostic classification", () => {
  it("prioritizes configured-app ownership", () => {
    const error = new MetaGraphRequestError({
      message: "server app rejected",
      status: 401,
      statusText: "Unauthorized",
      url: "https://graph.facebook.com/debug_token",
      details: null,
      metaError: { message: "invalid token", type: "OAuthException", code: 190 },
    });

    expect(
      classifyWhatsAppMetaDiagnosticError(
        attributeMetaCredentialOwner(error, "configured_app")
      )
    ).toBe("configured_app");
  });

  it("distinguishes throttling, customer authorization, and transient failures", () => {
    expect(
      classifyWhatsAppMetaDiagnosticError({
        status: 400,
        metaError: { code: 80008 },
      })
    ).toBe("rate_limited");
    expect(
      classifyWhatsAppMetaDiagnosticError({
        status: 401,
        metaError: { code: 190 },
      })
    ).toBe("authorization");
    expect(classifyWhatsAppMetaDiagnosticError(new Error("network"))).toBe(
      "transient"
    );
  });
});
