/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import {
  KB_EDITOR_CODE_BLOCK_CLASS_NAME,
  KB_EDITOR_IMAGE_CLASS_NAME,
  KB_EDITOR_INLINE_CODE_CLASS_NAME,
  KB_EDITOR_TABLE_CELL_CLASS_NAME,
  KB_EDITOR_TABLE_CLASS_NAME,
  KB_EDITOR_TABLE_WRAPPER_CLASS_NAME,
} from "@/lib/kb/kb-editor-classes";
import { ArticleContent } from "./article-content";

describe("ArticleContent", () => {
  it("accepts a public article content class for responsive published article styles", () => {
    render(
      <ArticleContent
        content="<p>Published content</p>"
        className="public-kb-article-content"
      />
    );

    expect(screen.getByText("Published content").parentElement).toHaveClass(
      "public-kb-article-content"
    );
  });

  it("renders persisted Supabase KB image tags in public article content", () => {
    render(
      <ArticleContent
        content={`<p>Before image</p><img class="rounded-md my-6 kb-editor-image" loading="lazy" decoding="async" src="https://wnycyavumykzejnjelfb.supabase.co/storage/v1/object/public/kb-attachments/kb/article/image.png" alt="KB image"><blockquote><p>After image</p></blockquote>`}
      />
    );

    const image = screen.getByRole("img", { name: "KB image" });
    expect(image).toHaveAttribute(
      "src",
      "https://wnycyavumykzejnjelfb.supabase.co/storage/v1/object/public/kb-attachments/kb/article/image.png"
    );
  });

  it("renders persisted article line breaks as childless void tags", () => {
    const { container } = render(
      <ArticleContent content="<p>Before<br><br>After</p>" />
    );

    expect(container.querySelectorAll("br")).toHaveLength(2);
    expect(container).toHaveTextContent("BeforeAfter");
  });

  it("renders markdown links and tables from mixed article content", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const { container } = render(
        <ArticleContent
          content={[
            "Intro<br><br>[Meta docs](https://developers.facebook.com/docs/whatsapp/)",
            "",
            "| Provider | Bulk campaigns |",
            "| --- | --- |",
            "| Official | Yes |",
          ].join("\n")}
        />
      );

      const link = screen.getByRole("link", { name: "Meta docs" });
      expect(link).toHaveAttribute(
        "href",
        "https://developers.facebook.com/docs/whatsapp/"
      );
      const wrapper = container.querySelector(
        `.${KB_EDITOR_TABLE_WRAPPER_CLASS_NAME}`
      );
      const table = wrapper?.querySelector("table");

      expect(wrapper).toBeInTheDocument();
      expect(table).toBeInTheDocument();
      expect(table).toHaveClass(...KB_EDITOR_TABLE_CLASS_NAME.split(" "));
      expect(
        screen.getByRole("columnheader", { name: "Provider" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("cell", { name: "Official" })
      ).toBeInTheDocument();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves safe table cell attributes from persisted HTML", () => {
    render(
      <ArticleContent
        content={`<table><thead><tr><th align="right" scope="col">Plan</th></tr></thead><tbody><tr><td colspan="2" rowspan="3">Pro</td></tr></tbody></table>`}
      />
    );

    expect(screen.getByRole("columnheader", { name: "Plan" })).toHaveStyle({
      textAlign: "right",
    });
    expect(screen.getByRole("columnheader", { name: "Plan" })).toHaveClass(
      ...KB_EDITOR_TABLE_CELL_CLASS_NAME.split(" ")
    );
    expect(screen.getByRole("cell", { name: "Pro" })).toHaveAttribute(
      "colspan",
      "2"
    );
    expect(screen.getByRole("cell", { name: "Pro" })).toHaveAttribute(
      "rowspan",
      "3"
    );
  });

  it("keeps safe Tiptap colgroup widths for public table layout", () => {
    const { container } = render(
      <ArticleContent
        content={`<table><colgroup><col style="width: 180px"><col width="120"></colgroup><tbody><tr><td>Official</td><td>No</td></tr></tbody></table>`}
      />
    );

    const columns = container.querySelectorAll("col");
    expect(columns).toHaveLength(2);
    expect(columns[0]).toHaveStyle({ width: "180px" });
    expect(columns[1]).toHaveStyle({ width: "120px" });
  });

  it("renders common markdown entities with editor-compatible public markup", () => {
    const { container } = render(
      <ArticleContent
        content={[
          "# Heading",
          "",
          'Paragraph with **bold**, *italic*, ~~strike~~, `inline code`, [Airi](https://airi.chat), and ![Logo](https://example.com/logo.png "Logo title").',
          "",
          "> Quote",
          "",
          "- one",
          "- two",
          "",
          "1. first",
          "2. second",
          "",
          "- [x] done",
          "- [ ] todo",
          "",
          "---",
          "",
          "```js",
          "console.log('x')",
          "```",
        ].join("\n")}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Heading" })
    ).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(container.querySelector("del")).toHaveTextContent("strike");
    expect(container.querySelector("blockquote")).toHaveTextContent("Quote");
    expect(container.querySelector("ul")).toHaveTextContent("one");
    expect(container.querySelector("ol")).toHaveTextContent("first");
    expect(container.querySelector("hr")).toBeInTheDocument();

    const inlineCode = container.querySelector(
      `code.${KB_EDITOR_INLINE_CODE_CLASS_NAME}`
    );
    expect(inlineCode).toHaveTextContent("inline code");

    const codeBlock = container.querySelector("pre");
    expect(codeBlock).toHaveClass(
      ...KB_EDITOR_CODE_BLOCK_CLASS_NAME.split(" ")
    );
    expect(codeBlock?.querySelector("code")).toHaveClass("language-js");

    const link = screen.getByRole("link", { name: "Airi" });
    expect(link).toHaveAttribute("href", "https://airi.chat");

    const image = screen.getByRole("img", { name: "Logo" });
    expect(image).toHaveClass("kb-editor-image");
    expect(image).toHaveClass(...KB_EDITOR_IMAGE_CLASS_NAME.split(" "));
    expect(image).toHaveAttribute("title", "Logo title");

    const taskCheckboxes = screen.getAllByRole("checkbox");
    expect(taskCheckboxes).toHaveLength(2);
    expect(taskCheckboxes[0]).toBeChecked();
    expect(taskCheckboxes[1]).not.toBeChecked();
    expect(taskCheckboxes[0]).toBeDisabled();
  });

  it("preserves safe editor rich-text styles in public article content", () => {
    render(
      <ArticleContent
        content={`<p style="text-align: center">Centered</p><span style="color: #ef4444; background-color: #fef3c7; font-family: Inter">Styled text</span><img src="https://example.com/image.png" alt="Sized" data-width="320" data-height="180">`}
      />
    );

    expect(screen.getByText("Centered")).toHaveStyle({ textAlign: "center" });
    expect(screen.getByText("Styled text")).toHaveStyle({
      color: "#ef4444",
      backgroundColor: "#fef3c7",
      fontFamily: "Inter",
    });
    expect(screen.getByRole("img", { name: "Sized" })).toHaveStyle({
      width: "320px",
      height: "180px",
    });
  });

  it("renders published YouTube embeds and drops other iframes", () => {
    const { container } = render(
      <ArticleContent
        content={`<p>Before video</p><div data-youtube-video=""><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" width="960" height="540"></iframe></div><iframe src="https://evil.example/embed"></iframe><p>After video</p>`}
      />
    );

    const iframes = container.querySelectorAll("iframe");
    expect(iframes).toHaveLength(1);
    expect(iframes[0]).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
    expect(iframes[0]).toHaveClass("kb-editor-youtube-iframe");
    expect(container.querySelector("[data-youtube-video]")).toBeInTheDocument();
    expect(screen.getByText("Before video")).toBeInTheDocument();
    expect(screen.getByText("After video")).toBeInTheDocument();
  });
});
