/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import PanelRouteLoading from "@/app/panel/loading";
import PanelLoadingView from "./loading-view";

const mockPathname = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));
jest.mock("@/components/scenarios/scenarios-workspace-skeleton", () => ({
  ScenariosWorkspaceSkeleton: () => <div data-testid="scenarios-skeleton" />,
}));
jest.mock("@/components/ui/panel-skeleton", () => ({
  PanelSkeleton: () => <div data-testid="panel-skeleton" />,
}));

function renderAt(pathname: string | null) {
  mockPathname.mockReturnValue(pathname);
  return render(<PanelLoadingView />);
}

describe("panel loading ownership", () => {
  it("uses one canonical loading view for the panel route", () => {
    expect(PanelRouteLoading).toBe(PanelLoadingView);
  });

  it.each([
    "/panel/w/workspace-1/scenarios",
    "/panel/w/workspace-1/scenarios/",
  ])("shows the scenarios frame while %s waits", pathname => {
    const { container } = renderAt(pathname);

    expect(screen.getByTestId("scenarios-skeleton")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveClass("justify-center");
  });

  it.each([
    "/panel/w/workspace-1",
    "/panel/w/workspace-1/kb",
    "/panel/w/workspace-1/scenarios/extra",
    "/panel/w/workspace-1/scenarios-extra",
  ])("shows the generic panel frame for %s", pathname => {
    renderAt(pathname);

    expect(screen.getByTestId("panel-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("scenarios-skeleton")).not.toBeInTheDocument();
  });

  it.each(["/", "/login", "/panel", "/panel/workspaces/new", null])(
    "keeps the full-screen spinner for %s",
    pathname => {
      const { container } = renderAt(pathname);

      expect(
        screen.getByRole("status", { name: "Loading" })
      ).toBeInTheDocument();
      expect(screen.queryByTestId("panel-skeleton")).not.toBeInTheDocument();
      expect(container.firstElementChild).toHaveClass(
        "flex items-center justify-center h-screen"
      );
    }
  );
});
