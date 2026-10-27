/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { PublicKBArticleActions } from "./public-kb-article-actions";

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const writeText = jest.fn();

const labels = {
  copyMarkdown: "Copy Markdown",
  copyForLLM: "Copy for LLM",
  copiedMarkdown: "Markdown copied",
  copiedForLLM: "LLM text copied",
  copyFailed: "Could not copy",
};

function renderActions() {
  return render(
    <PublicKBArticleActions
      title="Q/A"
      content={`<h2>Setup</h2><p>Use <strong>templates</strong> and <a href="https://airi.chat/flows">flows</a>.</p>`}
      articleUrl="https://airi.chat/airichat/kb/qa"
      companyName="airi.chat"
      locale="en"
      publishedAt="2026-06-21T00:00:00.000Z"
      updatedAt="2026-06-22T00:00:00.000Z"
      labels={labels}
    />
  );
}

describe("PublicKBArticleActions", () => {
  beforeEach(() => {
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    jest.clearAllMocks();
  });

  it("copies the article as Markdown", async () => {
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          "# Q/A",
          "",
          "## Setup",
          "",
          "Use **templates** and [flows](https://airi.chat/flows).",
        ].join("\n")
      );
    });
    expect(toast.success).toHaveBeenCalledWith("Markdown copied");
  });

  it("copies an LLM-oriented payload with metadata", async () => {
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Copy for LLM" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        [
          "# Q/A",
          "",
          "Source: https://airi.chat/airichat/kb/qa",
          "Company: airi.chat",
          "Locale: en",
          "Published: 2026-06-21T00:00:00.000Z",
          "Updated: 2026-06-22T00:00:00.000Z",
          "",
          "## Setup",
          "",
          "Use **templates** and [flows](https://airi.chat/flows).",
        ].join("\n")
      );
    });
    expect(toast.success).toHaveBeenCalledWith("LLM text copied");
  });

  it("falls back to textarea copy when the Clipboard API is unavailable", async () => {
    let fallbackValue = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: jest.fn(() => {
        fallbackValue =
          document.querySelector("textarea")?.getAttribute("value") ||
          (document.querySelector("textarea") as HTMLTextAreaElement | null)
            ?.value ||
          "";
        return true;
      }),
    });

    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));

    await waitFor(() => {
      expect(document.execCommand).toHaveBeenCalledWith("copy");
    });
    expect(fallbackValue).toContain("# Q/A");
    expect(fallbackValue).toContain("## Setup");
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Markdown copied");
  });
});
