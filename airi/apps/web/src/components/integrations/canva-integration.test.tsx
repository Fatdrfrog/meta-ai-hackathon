/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CanvaIntegration } from "./canva-integration";
import type { Source } from "@/types/supabase";

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const messages: Record<string, string> = {
      "CanvaIntegration.title": "Canva brand templates",
      "CanvaIntegration.description":
        "Connect Canva to search brand templates.",
      "CanvaIntegration.disconnectedTitle": "Canva is not connected",
      "CanvaIntegration.disconnectedDescription":
        "Authorize Canva to use brand templates.",
      "CanvaIntegration.connectedTitle": "Canva is connected",
      "CanvaIntegration.connectedDescription": "Brand templates are available.",
      "CanvaIntegration.connect": "Connect Canva",
      "CanvaIntegration.reconnect": "Reconnect Canva",
      "CanvaIntegration.connectedBadge": "Connected",
      "CanvaIntegration.scopeLabel": "Scope",
      "CanvaIntegration.connectedAtLabel": "Connected",
    };

    return (key: string) => messages[`${namespace}.${key}`] ?? key;
  },
}));

describe("CanvaIntegration", () => {
  it("links disconnected users to the Canva OAuth start route", () => {
    render(<CanvaIntegration workspaceId="workspace-1" source={undefined} />);

    expect(screen.getByRole("link", { name: "Connect Canva" })).toHaveAttribute(
      "href",
      "/api/sources/canva/connect?workspaceId=workspace-1"
    );
  });

  it("shows connected state and keeps reconnect available", () => {
    const source = {
      id: "source-1",
      created_at: "2026-05-04T00:00:00.000Z",
      company_id: "company-1",
      workspace_id: "workspace-1",
      type: "canva",
      name: "Canva",
      credentials: {
        connected_at: "2026-05-04T00:00:00.000Z",
        scope: "brandtemplate:meta:read",
      },
    } satisfies Source;

    render(<CanvaIntegration workspaceId="workspace-1" source={source} />);

    expect(screen.getByText("Canva is connected")).toBeInTheDocument();
    expect(screen.getByText("brandtemplate:meta:read")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Reconnect Canva" })
    ).toHaveAttribute(
      "href",
      "/api/sources/canva/connect?workspaceId=workspace-1"
    );
  });
});
