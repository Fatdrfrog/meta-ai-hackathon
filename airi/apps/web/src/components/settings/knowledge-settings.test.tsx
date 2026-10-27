/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { AiContextManager } from "./ai-context-manager";
import { AiriLanguageSelector } from "./airi-language-selector";
import { PublicUrlIndexer } from "./public-url-indexer";
import { AiriQAManager } from "./airi-qa-manager";

jest.mock("next-intl", () => {
  const t = (key: string) => key;
  return { useTranslations: () => t };
});
jest.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "workspace_1" }),
  useRouter: () => ({ refresh: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("swr", () => ({
  __esModule: true,
  default: () => ({ data: undefined }),
}));
const response = (data: unknown, ok = true) => ({ ok, json: async () => data });

describe("knowledge and language settings", () => {
  beforeEach(() => jest.clearAllMocks());

  it("clears tag dirty state after a confirmed save", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ success: true }));
    render(<AiContextManager initialTags={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "salesGrowth" }));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("contextUpdated")
    );
    expect(screen.getByRole("button", { name: "saveChanges" })).toBeDisabled();
    expect(screen.queryByText("unsavedChanges")).not.toBeInTheDocument();
  });

  it("exposes language choices as keyboard accessible radios and confirms save locally", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ success: true }));
    render(<AiriLanguageSelector initialLanguage="en" />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    fireEvent.click(screen.getByLabelText("languages.ru.nativeName"));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("saveSuccess")
    );
    expect(screen.getByRole("button", { name: "saveChanges" })).toBeDisabled();
    expect(screen.queryByText("unsavedChanges")).not.toBeInTheDocument();
  });

  it("shows URL load failure instead of an empty list and disables adding", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ error: "unavailable" }, false));
    render(<PublicUrlIndexer />);
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByText("noUrls")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "addButton" })).toBeDisabled();
  });

  it("reports queued ingestion without claiming indexing already completed", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ urls: [], limit: 5, remaining: 5 }))
      .mockResolvedValueOnce(response({ success: true, queued: true }))
      .mockResolvedValueOnce(response({ urls: [], limit: 5, remaining: 4 }));
    render(<PublicUrlIndexer />);
    await screen.findByText("noUrls");
    fireEvent.change(screen.getByLabelText("addUrlLabel"), {
      target: { value: "https://example.com/knowledge" },
    });
    fireEvent.click(screen.getByRole("button", { name: "addButton" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "indexQueued",
        expect.any(Object)
      )
    );
  });

  it("does not render a failed answer fetch as no saved answers", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(response({ error: "unavailable" }, false));
    render(<AiriQAManager workspaceId="workspace_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByText("noSnippets")).not.toBeInTheDocument();
  });

  it("preserves unfinished answer pairs instead of silently dropping them", async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ items: [] }));
    render(<AiriQAManager workspaceId="workspace_1" />);
    await screen.findByText("noSnippets");
    fireEvent.change(screen.getByLabelText("commonQuestion"), {
      target: { value: "How do I pay?" },
    });
    fireEvent.change(screen.getByLabelText("commonAnswer"), {
      target: { value: "By card" },
    });
    fireEvent.click(screen.getByRole("button", { name: "addRow" }));
    fireEvent.change(screen.getAllByLabelText("commonQuestion")[1], {
      target: { value: "What about cash?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "saveAll" }));
    expect(toast.error).toHaveBeenCalledWith("incompletePairs");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText("commonQuestion")[1]).toHaveValue(
      "What about cash?"
    );
  });

  it("reports delete failures instead of swallowing them", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [{ id: "answer_1", question: "Payment?", answer: "Card" }],
        })
      )
      .mockResolvedValueOnce(response({}, false));
    render(<AiriQAManager workspaceId="workspace_1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "deleteAnswer" })
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("deleteFailed")
    );
    expect(screen.getByText("Card")).toBeInTheDocument();
  });
});
