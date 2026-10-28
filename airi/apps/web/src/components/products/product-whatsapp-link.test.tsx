/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { WhatsAppLinkButton } from "./product-whatsapp-link";

// "Send from WhatsApp": a code to scan, which links the owner's phone so the
// shelf videos they send to Airi land in the workspace.

const mockToDataUrl = jest.fn();
jest.mock("qrcode", () => ({
  __esModule: true,
  default: { toDataURL: (...args: unknown[]) => mockToDataUrl(...args) },
}));

const LINK_URL = "https://wa.me/77082609346?text=Link%20my%20shop";
let respond: () => unknown;

beforeEach(() => {
  mockToDataUrl.mockReset().mockResolvedValue("data:image/png;base64,QR");
  respond = () => ({
    ok: true,
    status: 201,
    json: async () => ({
      url: LINK_URL,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  });
  global.fetch = jest.fn(async () => respond()) as unknown as typeof fetch;
});

function renderButton() {
  render(
    <WhatsAppLinkButton workspaceId="workspace-1" number="+7 708 260 9346" />
  );
  fireEvent.click(screen.getByRole("button", { name: "Send from WhatsApp" }));
}

describe("WhatsAppLinkButton", () => {
  it("shows a code to scan and a link to open WhatsApp with it", async () => {
    renderButton();

    expect(
      await screen.findByRole("img", { name: "Send videos from your phone" })
    ).toHaveAttribute("src", "data:image/png;base64,QR");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/products/whatsapp-link",
      { method: "POST" }
    );
    expect(mockToDataUrl).toHaveBeenCalledWith(LINK_URL, expect.anything());
    expect(screen.getByRole("link", { name: "Open WhatsApp" })).toHaveAttribute(
      "href",
      LINK_URL
    );
    expect(
      screen.getByText(/send to Airi at \+7 708 260 9346 turns up here/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("The code works once, for 30 minutes.")
    ).toBeInTheDocument();
  });

  it("offers to try again when the code can't be made", async () => {
    respond = () => ({ ok: false, status: 503, json: async () => ({}) });
    renderButton();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The code couldn't be made. Try again."
    );
    respond = () => ({
      ok: true,
      status: 201,
      json: async () => ({
        url: LINK_URL,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("link", { name: "Open WhatsApp" })
    ).toBeInTheDocument();
  });
});
