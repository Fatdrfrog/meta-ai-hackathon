/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import {
  installMatchMedia,
  installResizeObserver,
} from "@/test-support/dom-test-utils";
import { CampaignTestSendDialog } from "./campaign-test-send-dialog";

jest.mock("next-intl", () =>
  jest
    .requireActual("@/test-support/next-intl-test-utils")
    .createCatalogNextIntlMock(
      jest.requireActual("../../../messages/analytics/en/page.json")
    )
);

const mockFetchPhone = jest.fn();
const mockPostTestSend = jest.fn();
jest.mock("@/lib/whatsapp/test-send", () => ({
  fetchWhatsAppTestPhone: () => mockFetchPhone(),
  postWhatsAppTestSend: (...args: unknown[]) => mockPostTestSend(...args),
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));

const props = {
  workspaceId: "workspace-1",
  sourceId: "source-2",
  template: { name: "spring_offer", language: "ru" },
  variables: { "1": "Dana" },
  recipientName: "Dana",
  valuesFrom: "recipient" as const,
};

function openDialog() {
  fireEvent.click(
    screen.getByRole("button", { name: "Send a test to my WhatsApp" })
  );
  return screen.getByRole("dialog");
}

describe("CampaignTestSendDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installMatchMedia();
    installResizeObserver();
    mockFetchPhone.mockResolvedValue(null);
  });

  it("prefills the saved number and sends the chosen template with the first recipient's values", async () => {
    mockFetchPhone.mockResolvedValue("77012345678");
    mockPostTestSend.mockResolvedValue({
      ok: true,
      to: "77012345678",
      messageId: "wamid.1",
    });
    render(<CampaignTestSendDialog {...props} />);
    openDialog();

    const input = screen.getByLabelText("Your WhatsApp number");
    await waitFor(() => expect(input).toHaveValue("+77012345678"));
    expect(
      screen.getByText(/Variables use the first recipient's values\./)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Test sent to +77012345678. Check WhatsApp on that phone."
      )
    );
    expect(mockPostTestSend).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-2",
      to: "+77012345678",
      templateName: "spring_offer",
      language: "ru",
      variables: { "1": "Dana" },
      recipientName: "Dana",
      origin: "bulk_builder",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("never overwrites a number the user already typed", async () => {
    let resolvePhone: (phone: string) => void = () => undefined;
    mockFetchPhone.mockReturnValue(
      new Promise<string>(resolve => {
        resolvePhone = resolve;
      })
    );
    render(<CampaignTestSendDialog {...props} />);
    openDialog();

    const input = screen.getByLabelText("Your WhatsApp number");
    fireEvent.change(input, { target: { value: "+7 705 000 00 00" } });
    resolvePhone("77012345678");

    await waitFor(() => expect(mockFetchPhone).toHaveBeenCalled());
    expect(input).toHaveValue("+7 705 000 00 00");
  });

  it("never submits the campaign form it sits in", async () => {
    mockFetchPhone.mockResolvedValue("77012345678");
    mockPostTestSend.mockResolvedValue({
      ok: true,
      to: "77012345678",
      messageId: "wamid.1",
    });
    const submitCampaign = jest.fn((event: { preventDefault(): void }) =>
      event.preventDefault()
    );
    render(
      <form onSubmit={submitCampaign}>
        <CampaignTestSendDialog {...props} />
      </form>
    );
    openDialog();
    await waitFor(() =>
      expect(screen.getByLabelText("Your WhatsApp number")).toHaveValue(
        "+77012345678"
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    await waitFor(() => expect(mockPostTestSend).toHaveBeenCalled());
    expect(submitCampaign).not.toHaveBeenCalled();
  });

  it("checks the number before sending", () => {
    render(<CampaignTestSendDialog {...props} />);
    openDialog();

    fireEvent.change(screen.getByLabelText("Your WhatsApp number"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    expect(
      screen.getByText(/Enter a WhatsApp number with the country code/)
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Your WhatsApp number")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(mockPostTestSend).not.toHaveBeenCalled();
  });

  it("explains a refused send and keeps the dialog open", async () => {
    mockPostTestSend.mockResolvedValue({
      ok: false,
      code: "template_variables_missing",
      variables: ["3"],
    });
    render(<CampaignTestSendDialog {...props} valuesFrom="sample" />);
    openDialog();
    expect(
      screen.getByText(/Variables use the template's sample values\./)
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Your WhatsApp number"), {
      target: { value: "+7 701 234 56 78" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));

    expect(
      await screen.findByText(
        "Fill in {{3}} for the first recipient and try again."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("is unavailable while a campaign is being sent", () => {
    render(<CampaignTestSendDialog {...props} disabled />);
    expect(
      screen.getByRole("button", { name: "Send a test to my WhatsApp" })
    ).toBeDisabled();
  });
});
