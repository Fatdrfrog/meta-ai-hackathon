/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { KBBreadcrumbs } from "./kb-breadcrumbs";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const messages: Record<string, string> = {
      knowledgeBase: "Knowledge Base",
      workspace: "Workspace",
      editArticle: "Edit article",
      newArticle: "New article",
    };
    return messages[key] ?? key;
  },
}));

jest.mock("jotai", () => ({
  useAtom: () => ["airichat"],
}));

jest.mock("@/lib/navigation/company-slug-state", () => ({
  companySlugAtom: {},
}));

describe("KBBreadcrumbs", () => {
  it("shows only ancestor context on public article pages", () => {
    render(
      <KBBreadcrumbs
        mode="public"
        companySlug="airichat"
        articleId="current"
        articleTitle="Current article"
        ancestors={[{ id: "parent", title: "Parent article" }]}
      />
    );

    const breadcrumb = screen.getByRole("navigation", {
      name: "Breadcrumb",
    });

    expect(
      within(breadcrumb).queryByText("Knowledge Base")
    ).not.toBeInTheDocument();
    expect(
      within(breadcrumb).getByRole("link", { name: "Parent article" })
    ).toHaveAttribute("href", "/airichat/kb/parent");
    expect(
      within(breadcrumb).queryByText("Current article")
    ).not.toBeInTheDocument();
  });

  it("does not render a public breadcrumb when only the current article is available", () => {
    render(
      <KBBreadcrumbs
        mode="public"
        companySlug="airichat"
        articleId="current"
        articleTitle="Current article"
      />
    );

    expect(
      screen.queryByRole("navigation", { name: "Breadcrumb" })
    ).not.toBeInTheDocument();
  });

  it("keeps the Knowledge Base crumb in the admin editor breadcrumbs", () => {
    render(
      <KBBreadcrumbs
        mode="admin"
        workspaceId="workspace-1"
        workspaceName="Workspace"
        articleId="current"
        articleTitle="Current article"
      />
    );

    const breadcrumb = screen.getByRole("navigation", {
      name: "Breadcrumb",
    });

    expect(
      within(breadcrumb).getByRole("link", { name: "Knowledge Base" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/kb");
  });
});
