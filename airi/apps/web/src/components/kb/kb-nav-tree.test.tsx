/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar";
import { KBNavTree } from "./kb-nav-tree";
import { installMatchMedia } from "@/test-support/dom-test-utils";

const prefetch = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch }),
}));

jest.mock("jotai", () => ({
  useAtom: () => ["airichat"],
}));

jest.mock("@/lib/navigation/company-slug-state", () => ({
  companySlugAtom: {},
}));

describe("KBNavTree", () => {
  beforeEach(() => {
    prefetch.mockClear();
    installMatchMedia();
  });

  it("constrains long parent article titles inside the sidebar row", () => {
    const longTitle =
      "Как зарегистрироваться в Airi.chat and keep this very long title inside the sidebar";

    render(
      <SidebarProvider>
        <SidebarMenu>
          <KBNavTree
            mode="public"
            companySlug="airichat"
            articles={[
              {
                id: "parent",
                title: longTitle,
                workspace_id: "workspace-1",
                parent_id: null,
                sort_order: 1,
              },
              {
                id: "child",
                title: "Child article",
                workspace_id: "workspace-1",
                parent_id: "parent",
                sort_order: 1,
              },
            ]}
          />
        </SidebarMenu>
      </SidebarProvider>
    );

    const title = screen.getByText(longTitle);

    expect(title).toHaveClass("min-w-0");
    expect(title).toHaveClass("truncate");
    expect(title.parentElement).toHaveClass("min-w-0");
  });

  it("still expands the current article when the parent chain has a cycle", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <KBNavTree
            mode="public"
            companySlug="airichat"
            currentArticleId="child"
            articles={[
              {
                id: "root",
                title: "Root article",
                workspace_id: "workspace-1",
                parent_id: null,
                sort_order: 1,
              },
              {
                id: "parent",
                title: "Parent article",
                workspace_id: "workspace-1",
                parent_id: "child",
                sort_order: 1,
              },
              {
                id: "child",
                title: "Child article",
                workspace_id: "workspace-1",
                parent_id: "parent",
                sort_order: 1,
              },
            ]}
          />
        </SidebarMenu>
      </SidebarProvider>
    );

    expect(screen.getByText("Root article")).toBeInTheDocument();
  });

  it("expands ancestor folders of the current article on first render", () => {
    render(
      <SidebarProvider>
        <SidebarMenu>
          <KBNavTree
            mode="public"
            companySlug="airichat"
            currentArticleId="grandchild"
            articles={[
              {
                id: "root",
                title: "Root article",
                workspace_id: "workspace-1",
                parent_id: null,
                sort_order: 1,
              },
              {
                id: "child",
                title: "Child article",
                workspace_id: "workspace-1",
                parent_id: "root",
                sort_order: 1,
              },
              {
                id: "grandchild",
                title: "Grandchild article",
                workspace_id: "workspace-1",
                parent_id: "child",
                sort_order: 1,
              },
            ]}
          />
        </SidebarMenu>
      </SidebarProvider>
    );

    expect(screen.getByText("Root article")).toBeInTheDocument();
    expect(screen.getByText("Child article")).toBeInTheDocument();
    expect(screen.getByText("Grandchild article")).toBeInTheDocument();
  });
});
