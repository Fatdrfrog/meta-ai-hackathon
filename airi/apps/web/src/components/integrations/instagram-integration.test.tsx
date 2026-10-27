/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { InstagramSource } from "@/types/supabase";
import { InstagramIntegration } from "./instagram-integration";

function expiringSource(authMethod: string): InstagramSource {
  return {
    id: "instagram-source-1",
    created_at: "2026-01-01T00:00:00.000Z",
    company_id: "company-2",
    workspace_id: "workspace-2",
    type: "instagram",
    name: "Instagram",
    credentials: {
      auth_method: authMethod,
      token_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
  };
}

describe.each([
  {
    state: "disconnected",
    source: undefined,
    labels: ["connectViaFacebook", "connectInstagram"],
  },
  {
    state: "Facebook reconnection",
    source: expiringSource("facebook_login"),
    labels: ["reconnectViaFacebook"],
  },
  {
    state: "Instagram reconnection",
    source: expiringSource("instagram_business_login"),
    labels: ["reconnectInstagram"],
  },
])("InstagramIntegration: $state", ({ source, labels }) => {
  it("enables connection actions for the selected workspace", () => {
    render(<InstagramIntegration workspaceId="workspace-2" source={source} />);

    for (const label of labels) {
      expect(screen.getByRole("button", { name: label })).toBeEnabled();
    }
  });

  it("disables connection actions when no workspace is selected", () => {
    render(<InstagramIntegration source={source} />);

    for (const label of labels) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });

  it("preserves disabled connection actions in preview mode", () => {
    render(
      <InstagramIntegration
        workspaceId="workspace-2"
        source={source}
        connectionActionsDisabled
      />
    );

    for (const label of labels) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });
});
