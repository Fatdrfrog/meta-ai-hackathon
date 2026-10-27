/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { marked } from "marked";
import { ConversationMessageMarkdown } from "./conversation-message-markdown";

describe("ConversationMessageMarkdown", () => {
  it.each(["link", "image"] as const)(
    "preserves safe destinations and labels for %s tokens",
    type => {
      const lexer = jest.spyOn(marked, "lexer").mockReturnValueOnce(
        Object.assign(
          [
            {
              type: "paragraph" as const,
              raw: "",
              text: "",
              tokens: [
                ["https://example.com/receipt", "Receipt"],
                ["mailto:sales@example.com", "Email"],
                ["tel:+77001234567", "Phone"],
                ["/orders/1", "Order"],
                ["javascript:alert(1)", "Unsafe script"],
                ["data:text/html,hello", "Unsafe data"],
              ].map(([href, text]) => ({
                type,
                raw: "",
                href,
                text,
                title: "Destination",
                tokens: [{ type: "text" as const, raw: text, text }],
              })),
            },
          ],
          { links: {} }
        )
      );
      try {
        const { container } = render(
          <ConversationMessageMarkdown text="[receipt](https://example.com)" />
        );
        expect(screen.getAllByRole("link")).toHaveLength(4);
        for (const label of ["Receipt", "Email", "Phone"]) {
          const link = screen.getByRole("link", { name: label });
          expect(link).toHaveAttribute("target", "_blank");
          expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
          if (type === "link") {
            expect(link).toHaveAttribute("title", "Destination");
          } else {
            expect(link).not.toHaveAttribute("title");
          }
        }
        expect(screen.getByRole("link", { name: "Receipt" })).toHaveAttribute(
          "href",
          "https://example.com/receipt"
        );
        const orderLink = screen.getByRole("link", { name: "Order" });
        expect(orderLink).toHaveAttribute("href", "/orders/1");
        expect(orderLink).not.toHaveAttribute("target");
        expect(orderLink).not.toHaveAttribute("rel");
        expect(container).toHaveTextContent("Unsafe script");
        expect(container).toHaveTextContent("Unsafe data");
        expect(container.querySelector("img")).toBeNull();
      } finally {
        lexer.mockRestore();
      }
    }
  );

  it.each([
    "Hello, delivery is tomorrow. Thank you!",
    "Доставка по Алматы — завтра. Стоимость 12000 ₸.",
    "Тапсырыс дайын. Рақмет!",
    "Buyurtma tayyor. Rahmat!",
  ])("renders simple chat text without initializing Markdown: %s", text => {
    const lexer = jest.spyOn(marked, "lexer");
    try {
      render(<ConversationMessageMarkdown text={text} />);
      expect(screen.getByText(text).tagName).toBe("P");
      expect(lexer).not.toHaveBeenCalled();
    } finally {
      lexer.mockRestore();
    }
  });

  it.each([
    "**bold**",
    "_emphasis_",
    "~~removed~~",
    "`code`",
    "# Heading",
    "- item",
    "1) item",
    "140560. Invoice",
    "first\nsecond",
    "www.example.com",
    "https://example.com",
    "user@example.com",
    "[link](https://example.com)",
    "<script>alert(1)</script>",
    "&amp;",
    "escaped \\*star",
    "---",
  ])("preserves the canonical Markdown path for syntax and links: %s", text => {
    const lexer = jest.spyOn(marked, "lexer");
    try {
      render(<ConversationMessageMarkdown text={text} />);
      expect(lexer).toHaveBeenCalledTimes(1);
    } finally {
      lexer.mockRestore();
    }
  });
});
