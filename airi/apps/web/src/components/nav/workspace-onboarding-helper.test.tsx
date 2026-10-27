/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import {
  WorkspaceOnboardingHelper,
  WorkspaceOnboardingNavHelper,
} from "./workspace-onboarding-helper";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "progress" && values?.percent) return `${values.percent}%`;
    if (key === "steps.publish_knowledge.title") {
      return "Publish knowledge base articles before launch";
    }
    return key;
  },
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

function renderWithSWR(ui: ReactElement) {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>
  );
}

describe("WorkspaceOnboardingHelper", () => {
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        onboarding: {
          workspaceId: "workspace-1",
          progress: 0.4,
          completed: false,
          currentStepId: "create_scenario",
          steps: [
            {
              id: "create_scenario",
              current: 0,
              target: 1,
              completed: false,
              href: "/panel/w/workspace-1/scenarios",
            },
          ],
        },
      }),
    })) as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the next onboarding step as a compact navigation helper", async () => {
    renderWithSWR(
      <SidebarProvider>
        <WorkspaceOnboardingHelper workspaceId="workspace-1" />
      </SidebarProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/panel/w/workspace-1/scenarios"
      );
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/onboarding",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(screen.getByText("steps.create_scenario.title")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("hides after onboarding is completed", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        onboarding: {
          workspaceId: "workspace-1",
          progress: 1,
          completed: true,
          currentStepId: null,
          steps: [],
        },
      }),
    });

    renderWithSWR(
      <SidebarProvider>
        <WorkspaceOnboardingHelper workspaceId="workspace-1" />
      </SidebarProvider>
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders a compact top-nav helper without sidebar context", async () => {
    renderWithSWR(<WorkspaceOnboardingNavHelper workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "/panel/w/workspace-1/scenarios"
      );
    });

    expect(screen.getByText("steps.create_scenario.title")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("bounds long translated step titles in the compact top-nav helper", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        onboarding: {
          workspaceId: "workspace-1",
          progress: 0.6,
          completed: false,
          currentStepId: "publish_knowledge",
          steps: [
            {
              id: "publish_knowledge",
              current: 0,
              target: 1,
              completed: false,
              href: "/panel/w/workspace-1/kb",
            },
          ],
        },
      }),
    });

    renderWithSWR(<WorkspaceOnboardingNavHelper workspaceId="workspace-1" />);

    const link = await screen.findByRole("link", {
      name: /publish knowledge base articles before launch/i,
    });
    const stepLabel = screen.getByText(
      "Publish knowledge base articles before launch"
    );

    expect(link).toHaveClass("max-w-[11rem]");
    expect(link).toHaveClass("overflow-hidden");
    expect(link).toHaveClass("min-w-0");
    expect(stepLabel).toHaveClass("truncate");
    expect(screen.getByText("60%")).toBeInTheDocument();
  });
});
