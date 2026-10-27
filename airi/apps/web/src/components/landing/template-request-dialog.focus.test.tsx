/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TemplateMarketplace } from "./template-marketplace";
import { TemplateRequestDialog } from "./template-request-dialog";
import { installResizeObserver } from "@/test-support/dom-test-utils";

let mockIsMobile = false;
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockIsMobile }));
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/whatsapp-templates",
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations:
    (namespace?: string) =>
    (key: string, values?: Record<string, string | number>) => {
      const messages = jest.requireActual("../../../messages/en.json");
      const value = (namespace ? `${namespace}.${key}` : key)
        .split(".")
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part],
          messages
        );
      return Object.entries(values ?? {}).reduce(
        (text, [name, item]) => text.replace(`{${name}}`, String(item)),
        String(value)
      );
    },
}));
jest.mock("./page-header", () => ({
  LandingPageHeader: () => <header>airi.chat</header>,
}));
jest.mock("./template-preview", () => ({
  TemplatePreview: () => (
    <div data-testid="message-preview">
      Full selected message preview
      <a href="/sample.pdf">Open sample attachment</a>
    </div>
  ),
}));

function RequestHarness({ checking = false }: { checking?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Get this demo</button>
      <TemplateRequestDialog
        templateId={open ? "repeat-purchase" : null}
        onClose={() => setOpen(false)}
        source="marketplace"
        ready={!checking}
        readinessLoading={checking}
      />
    </>
  );
}

function openRequest() {
  const opener = screen.getByRole("button", { name: "Get this demo" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Template request dialog focus", () => {
  beforeAll(() => {
    installResizeObserver();
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent,
    });
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
  });
  beforeEach(() => {
    mockIsMobile = false;
    global.fetch = jest.fn();
    jest.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([false, true])(
    "opens on the visible heading rather than an editable field (mobile=%s)",
    async mobile => {
      mockIsMobile = mobile;
      render(<RequestHarness />);
      const opener = openRequest();
      const heading = screen.getByRole("heading", {
        name: "Repeat purchase",
      });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(screen.getByLabelText("Your name")).not.toHaveFocus();
      expect(screen.getByTestId("message-preview")).toBeVisible();
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(global.fetch).not.toHaveBeenCalled();

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());
    }
  );

  it("keeps focus out of inputs when availability finishes loading", async () => {
    mockIsMobile = true;
    const { rerender } = render(<RequestHarness checking />);
    openRequest();
    const heading = screen.getByRole("heading", {
      name: "Repeat purchase",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<RequestHarness />);
    expect(screen.getByLabelText("Your name")).not.toHaveFocus();
    expect(heading).toHaveFocus();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps the request before the complete preview in keyboard reading order", () => {
    mockIsMobile = true;
    render(<RequestHarness />);
    openRequest();
    const form = screen.getByLabelText("Your name").closest("form")!;
    const preview = screen.getByTestId("message-preview");
    expect(
      form.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING
    ).not.toBe(0);
  });

  it.each([
    ["gallery", "Escape"],
    ["gallery", "close button"],
    ["detail", "Escape"],
    ["detail", "close button"],
  ])(
    "restores the mobile %s CTA after %s when pointer activation clears its focus",
    async (surface, closeWith) => {
      mockIsMobile = true;
      const user = userEvent.setup();
      render(
        <TemplateMarketplace
          templateId={surface === "detail" ? "repeat-purchase" : undefined}
          readyTemplateIds={["repeat-purchase"]}
        />
      );
      const messages = jest.requireActual("../../../messages/en.json");
      const opener = screen.getByRole("button", {
        name: messages.LandingDemo.templates.getTemplateLabel.replace(
          "{title}",
          messages.LandingDemo.revenueWorkflows.repeat.title
        ),
      });
      opener.focus();
      expect(opener).toHaveFocus();
      // WebKit button activation can clear focus before the open callback runs.
      opener.blur();
      fireEvent.click(opener);
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAttribute("data-vaul-drawer", "");
      await waitFor(() =>
        expect(within(dialog).getByRole("heading")).toHaveFocus()
      );
      screen.getByRole("textbox", { name: "WhatsApp number" }).focus();
      if (closeWith === "Escape") await user.keyboard("{Escape}");
      else
        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(opener).toHaveFocus());
    }
  );
});
