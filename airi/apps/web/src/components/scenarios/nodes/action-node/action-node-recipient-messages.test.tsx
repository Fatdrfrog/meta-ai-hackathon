/** @jest-environment jsdom */

import "@testing-library/jest-dom";

const mockFetchMessages = jest.fn();
const mockPatchMessage = jest.fn();
const mockToastError = jest.fn();

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));
jest.mock("@/lib/scenarios/client", () => ({
  fetchScenarioGeneratorRecipientMessages: (...args: unknown[]) =>
    mockFetchMessages(...args),
  patchScenarioGeneratorRecipientMessage: (...args: unknown[]) =>
    mockPatchMessage(...args),
}));

import { act, fireEvent, render, screen } from "@testing-library/react";
import { ActionNodeRecipientMessages } from "./action-node-recipient-messages";

function renderMessages() {
  return render(
    <ActionNodeRecipientMessages
      activeScenarioId="scenario-1"
      branchId="branch-1"
      recipientCount={120}
      workspaceId="workspace-1"
    />
  );
}

beforeEach(() => {
  mockFetchMessages.mockReset();
  mockPatchMessage.mockReset();
  mockToastError.mockReset();
});

describe("ActionNodeRecipientMessages", () => {
  it("shows the recipient count and opens the personal texts", async () => {
    mockFetchMessages.mockResolvedValue({
      items: [
        {
          id: "m1",
          channel: "whatsapp",
          recipient: "+77001234567",
          recipientName: "Aigerim",
          text: "Hi Aigerim",
          sendStatus: "sent",
        },
        {
          id: "m2",
          channel: "telegram",
          recipient: "@bolat",
          text: "Hi Bolat",
          sendStatus: "preparing",
        },
        {
          id: "m3",
          channel: "whatsapp",
          recipient: "+77007654321",
          text: "Hi there",
          sendStatus: "failed",
        },
      ],
      total: 5,
      truncated: true,
    });
    const onCanvasClick = jest.fn();
    render(
      <div onClick={onCanvasClick}>
        <ActionNodeRecipientMessages
          activeScenarioId="scenario-1"
          branchId="branch-1"
          recipientCount={120}
          workspaceId="workspace-1"
        />
      </div>
    );
    expect(
      screen.getByText('columnSplitPathRecipientCount:{"count":120}')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/recipients in this generated branch/)
    ).toBeNull();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "recipientTextsOpen" })
      );
    });
    expect(onCanvasClick).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog", { name: "recipientTextsTitle" });
    expect(dialog).toHaveAccessibleDescription("recipientTextsDescription");
    expect(
      screen.getByText('recipientTextsShowing:{"shown":3,"total":5}')
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", {
        name: 'recipientTextFor:{"name":"Aigerim"}',
      })
    ).toHaveValue("Hi Aigerim");
    expect(
      screen.getByRole("textbox", {
        name: 'recipientTextFor:{"name":"@bolat"}',
      })
    ).toBeInTheDocument();
    expect(screen.getByText("recipientTextStatusSent")).toBeInTheDocument();
    // Unknown and in-flight states read as a draft.
    expect(screen.getByText("recipientTextStatusDraft")).toBeInTheDocument();
    expect(screen.getByText("recipientTextStatusFailed")).toBeInTheDocument();
    expect(screen.queryByText("preparing")).toBeNull();
    expect(
      screen.getAllByRole("img", { name: "actionSourceWhatsApp" })
    ).toHaveLength(2);
    expect(
      screen.getByRole("img", { name: "actionSourceTelegram" })
    ).toBeInTheDocument();
  });

  it("shows skeletons while loading and an empty line when there are none", async () => {
    let resolvePage: (page: unknown) => void = () => undefined;
    mockFetchMessages.mockReturnValue(
      new Promise(resolve => {
        resolvePage = resolve;
      })
    );
    renderMessages();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "recipientTextsOpen" })
      );
    });
    expect(screen.getAllByTestId("recipient-text-skeleton")).toHaveLength(3);

    await act(async () => {
      resolvePage({ items: [], total: 0, truncated: false });
    });
    expect(screen.queryByTestId("recipient-text-skeleton")).toBeNull();
    expect(screen.getByText("recipientTextsEmpty")).toBeInTheDocument();
  });

  it("reports a load failure without the server's raw text", async () => {
    mockFetchMessages.mockRejectedValueOnce(new Error("Mongo timeout 500"));
    renderMessages();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "recipientTextsOpen" })
      );
    });
    expect(mockToastError).toHaveBeenCalledWith("recipientTextsLoadFailed");
    expect(JSON.stringify(mockToastError.mock.calls)).not.toMatch(
      /Mongo timeout/
    );
  });

  it("reports a save failure without the server's raw text", async () => {
    renderMessages();
    mockFetchMessages.mockResolvedValueOnce({
      items: [
        {
          id: "m1",
          channel: "whatsapp",
          recipient: "+77001234567",
          text: "Hi",
        },
      ],
      total: 1,
      truncated: false,
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "recipientTextsOpen" })
      );
    });
    mockPatchMessage.mockRejectedValueOnce(new Error("Write conflict"));
    const textbox = screen.getByRole("textbox", {
      name: 'recipientTextFor:{"name":"+77001234567"}',
    });
    fireEvent.change(textbox, { target: { value: "Hello again" } });
    await act(async () => {
      fireEvent.blur(textbox);
    });
    expect(mockPatchMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "m1", text: "Hello again" })
    );
    expect(mockToastError).toHaveBeenLastCalledWith("recipientTextSaveFailed");
    expect(JSON.stringify(mockToastError.mock.calls)).not.toMatch(
      /Write conflict/
    );
  });

  it("renders nothing without a generated branch", () => {
    const { container } = render(
      <ActionNodeRecipientMessages
        activeScenarioId="scenario-1"
        branchId={null}
        recipientCount={3}
        workspaceId="workspace-1"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
