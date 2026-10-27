/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { KBAdminSidebar } from "./kb-admin-sidebar";

jest.mock("@/hooks/use-kb-articles", () => ({
  useKBArticles: () => ({
    articles: [],
    isLoading: false,
    mutate: jest.fn(),
  }),
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/panel/w/workspace-1/kb",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    prefetch: jest.fn(),
    push: jest.fn(),
  }),
}));

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const messages: Record<string, string> = {
      title: "Knowledge base",
      noArticlesYet: "No articles yet.",
      createFirstArticle:
        "Create your first article to start building your knowledge base",
      "newArticle.title": "New article",
    };
    const translate = (key: string) => messages[key] ?? key;
    translate.has = (key: string) => key in messages;
    return translate;
  },
}));

describe("KBAdminSidebar empty state", () => {
  it("keeps the first-article CTA within a narrow sidebar", () => {
    render(<KBAdminSidebar workspaceId="workspace-1" />);

    const createButton = screen.getByRole("button", {
      name: /create your first article/i,
    });

    expect(createButton).toHaveClass("w-full");
    expect(createButton).toHaveClass("max-w-full");
    expect(createButton).toHaveClass("whitespace-normal");
    expect(createButton).toHaveClass("min-w-0");
  });
});
