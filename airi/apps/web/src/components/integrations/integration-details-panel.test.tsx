/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import messages from "../../../messages/settings/integrations/en/page.json";
import { IntegrationDetailsPanel } from "./integration-details-panel";

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => {
    const value = `${namespace}.${key}`
      .split(".")
      .reduce<unknown>(
        (current, part) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[part]
            : undefined,
        messages
      );
    return typeof value === "string" ? value : key;
  },
}));
jest.mock("next-themes", () => ({ useTheme: () => ({ theme: "light" }) }));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => () => null,
}));
jest.mock("@/components/integrations/integration-setup-guide", () => ({
  IntegrationSetupGuide: () => null,
}));

const META_DETAILS =
  "(#200) Provider token=secret: Please reconnect WhatsApp integration.";

function renderBanner(
  integrationId: "whatsapp" | "instagram",
  error: string,
  errorDetails: string | null = META_DETAILS
) {
  return render(
    <IntegrationDetailsPanel
      sources={[]}
      emailIntegrationEnabled
      emailProviderStatus="disconnected"
      workspaceId="workspace-1"
      selectedIntegrationId={integrationId}
      error={error}
      errorDetails={errorDetails}
    />
  );
}

describe("IntegrationDetailsPanel WhatsApp error banner", () => {
  // Every code the Embedded Signup callback and the legacy routes redirect with.
  it.each([
    ["missing_code", "Meta sign-in didn't finish"],
    ["token_expired", "Meta sign-in couldn't be confirmed"],
    ["token_invalid", "Meta sign-in couldn't be confirmed"],
    ["token_revoked", "Meta access was removed"],
    ["permissions_error", "Meta permissions missing"],
    ["business_verification_required", "Business verification required"],
    ["phone_already_connected", "Number already connected"],
    [
      "company_channel_limit_exceeded",
      "Your plan doesn't allow this connection",
    ],
    ["whatsapp_flow_source_rebind_blocked", "Couldn't update this number"],
    ["connection_check_needed", "New Meta access not confirmed"],
    ["legacy_oauth_removed", "This setup link no longer works"],
    ["waba_not_found", "No WhatsApp Business account"],
    ["whatsapp_number_not_eligible", "Number is not eligible yet"],
    ["oauth_failed", "WhatsApp connection failed"],
    ["company_not_found", "Connection error"],
    ["whatsapp_save_failed", "Connection error"],
    ["embedded_signup_failed", "Connection error"],
    ["access_verification_incomplete", "Connection error"],
    ["User not associated with a workspace", "Connection error"],
  ])("explains %s without internal text", (error, title) => {
    const { container } = renderBanner("whatsapp", error);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(error);
    expect(container).not.toHaveTextContent(/token=secret|#200|reconnect/i);
  });

  it("gives unknown codes the generic message instead of echoing them", () => {
    const { container } = renderBanner(
      "whatsapp",
      "Visit evil.example to fix this",
      null
    );

    expect(
      screen.getByText(
        "Something went wrong while connecting WhatsApp. Try again, and contact support if it keeps happening."
      )
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent("evil.example");
  });
});

describe("IntegrationDetailsPanel Instagram error banner", () => {
  it("explains a plan limit like WhatsApp does", () => {
    renderBanner("instagram", "company_channel_limit_exceeded", null);

    expect(
      screen.getByText("Your plan doesn't allow this connection")
    ).toBeInTheDocument();
  });

  it("does not echo an unknown code when Meta sent no details", () => {
    const { container } = renderBanner("instagram", "boom_unknown", null);

    expect(screen.getByText("Instagram connection error")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Something went wrong while connecting Instagram. Try again, and contact support if it keeps happening."
      )
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent("boom_unknown");
  });
});
