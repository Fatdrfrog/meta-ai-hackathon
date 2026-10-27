/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TemplateRequestDialog } from "./template-request-dialog";
import { installResizeObserver } from "@/test-support/dom-test-utils";

let mockIsMobile = false;
let mockLocale = "en";
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mockIsMobile }));

installResizeObserver();

jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations: (namespace?: string) => (key: string) => {
    const messages = jest.requireActual(`../../../messages/${mockLocale}.json`);
    return (namespace ? namespace + "." + key : key)
      .split(".")
      .reduce<unknown>(
        (value, part) => (value as Record<string, unknown>)[part],
        messages
      );
  },
}));
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    autoFocus,
  }: {
    children: React.ReactNode;
    open: boolean;
    autoFocus?: boolean;
  }) => {
    const isMobile = jest.requireMock("@/hooks/use-mobile").useIsMobile();
    if (!open) return null;
    // Match the shared Dialog's replacement of its entire Modal/Drawer subtree.
    return isMobile ? (
      <section role="dialog" data-autofocus={autoFocus}>
        {children}
      </section>
    ) : (
      <div role="dialog">{children}</div>
    );
  },
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));
jest.mock("./template-preview", () => ({
  TemplatePreview: ({
    template,
  }: {
    template: import("@/lib/landing/public-template-catalog").PublicTemplate;
  }) => {
    const catalog = jest.requireActual("@/lib/landing/public-template-catalog");
    const translate = jest.requireMock("next-intl").useTranslations();
    return (
      <div>
        Sample preview
        <p>{catalog.getPublicTemplateText(template, "body", translate)}</p>
        <small>{catalog.getPublicTemplateFooter(template, translate)}</small>
      </div>
    );
  },
}));

describe("Public template request dialog", () => {
  it("keeps the complete selected message preview beside the request form", () => {
    render(
      <TemplateRequestDialog
        templateId="seasonal-offer"
        onClose={jest.fn()}
        source="marketplace"
        ready
      />
    );
    expect(
      screen.getByText(/\*airi.chat demo: seasonal offer\*/)
    ).toHaveTextContent("Fictional example");
    expect(screen.getByText("To unsubscribe: samat@airi.chat")).toBeVisible();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  beforeEach(() => {
    mockLocale = "en";
  });

  it.each(["en", "ru", "kz"])(
    "keeps the %s locale when browsing from an unavailable demo",
    locale => {
      mockLocale = locale;
      const messages = jest.requireActual(`../../../messages/${locale}.json`);
      render(
        <TemplateRequestDialog
          templateId="quote-ready"
          onClose={jest.fn()}
          source="marketplace"
        />
      );
      expect(
        screen.getByRole("link", {
          name: messages.LandingDemo.templates.browseAll,
        })
      ).toHaveAttribute(
        "href",
        `/whatsapp-templates${locale === "en" ? "" : `?locale=${locale}`}`
      );
    }
  );

  it("opens the same selected example with translated content in each locale", () => {
    const props = {
      templateId: "quote-ready",
      onClose: jest.fn(),
      source: "marketplace" as const,
    };
    const { rerender } = render(<TemplateRequestDialog {...props} />);
    expect(screen.getByRole("heading", { name: "Quote" })).toBeVisible();
    mockLocale = "ru";
    rerender(<TemplateRequestDialog {...props} />);
    const russian = jest.requireActual("../../../messages/ru.json");
    expect(
      screen.getByRole("heading", {
        name: russian.LandingDemo.templates.catalog["quote-ready"].title,
      })
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveTextContent("Q-204");
    mockLocale = "kz";
    rerender(<TemplateRequestDialog {...props} />);
    const kazakh = jest.requireActual("../../../messages/kz.json");
    expect(
      screen.getByRole("heading", {
        name: kazakh.LandingDemo.templates.catalog["quote-ready"].title,
      })
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toHaveTextContent("Q-204");
  });

  it.each([
    ["en", "future product updates and offers"],
    ["ru", "новости продукта и предложения"],
    ["kz", "өнім жаңалықтары мен ұсыныстарын"],
  ])(
    "clearly discloses future WhatsApp marketing in %s",
    (locale, expected) => {
      const messages = jest.requireActual(`../../../messages/${locale}.json`);
      const text = messages.LandingDemo.templates.consent;
      expect(text).toContain(expected);
      expect(text).toContain("airi.chat");
      expect(text).toContain("WhatsApp");
      expect(text).not.toMatch(
        /does not subscribe|Это не подписка|жазылу емес/
      );
    }
  );

  beforeEach(() => {
    global.fetch = jest.fn();
    mockIsMobile = false;
  });

  it("preserves an uncertain request when the responsive dialog switches to a drawer and back", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: "processing" }),
    });
    const props = {
      templateId: "welcome",
      onClose: jest.fn(),
      source: "marketplace" as const,
      ready: true,
    };
    const { rerender } = render(<TemplateRequestDialog {...props} />);
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp number"), {
      target: { value: "+77001234567" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send me this demo" }));
    await screen.findByText("Your request is not confirmed yet");

    mockIsMobile = true;
    rerender(<TemplateRequestDialog {...props} />);
    expect(screen.getByLabelText("Your name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Work email")).toHaveValue("ada@example.com");
    expect(screen.getByLabelText("WhatsApp number")).toHaveValue(
      "+77001234567"
    );
    expect(screen.getByLabelText("WhatsApp number")).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(JSON.parse(calls[0][1].body)).toEqual(JSON.parse(calls[1][1].body));
    await screen.findByText("Your request is not confirmed yet");

    mockIsMobile = false;
    rerender(<TemplateRequestDialog {...props} />);
    expect(screen.getByLabelText("Your name")).toHaveValue("Ada");
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("shows coming soon without collecting contact details for unbound examples", () => {
    render(
      <TemplateRequestDialog
        templateId="seasonal-offer"
        onClose={jest.fn()}
        source="marketplace"
      />
    );
    expect(screen.getByText("Demo coming soon")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Sample preview")).toBeVisible();
  });

  it("requires explicit consent and sends only the selected template request", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "accepted" }),
    });
    render(
      <TemplateRequestDialog
        templateId="abandoned-cart"
        onClose={jest.fn()}
        source="landing"
        ready
      />
    );
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp number"), {
      target: { value: "+77001234567" },
    });
    const consent = screen.getByRole("checkbox", {
      name: /this demo and future product updates and offers from airi.chat on WhatsApp/,
    });
    expect(consent).not.toBeChecked();
    const submit = screen.getByRole("button", { name: "Send me this demo" });
    expect(submit).toHaveAttribute("data-variant", "secondary");
    expect(submit).toHaveAttribute("data-full-width", "true");
    expect(submit.querySelector(".btn-push-front")).toBeNull();
    expect(submit).toBeDisabled();
    fireEvent.click(consent);
    fireEvent.click(submit);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({
        templateId: "abandoned-cart",
        locale: "en",
        name: "Ada",
        email: "ada@example.com",
        phone: "+77001234567",
        consent: true,
        consentVersion: "public-template-demo-marketing-v2",
        source: "landing",
        website: "",
        requestId: expect.any(String),
      })
    );
    expect(await screen.findByText("Your demo is queued")).toBeVisible();
  });

  it("retains one request ID when retrying a processing request", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: "processing" }),
    });
    render(
      <TemplateRequestDialog
        templateId="welcome"
        onClose={jest.fn()}
        source="marketplace"
        ready
      />
    );
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp number"), {
      target: { value: "+77001234567" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send me this demo" }));
    await screen.findByText("Your request is not confirmed yet");
    expect(screen.getByLabelText("Your name")).toBeDisabled();
    expect(screen.getByLabelText("Work email")).toBeDisabled();
    expect(screen.getByLabelText("WhatsApp number")).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(JSON.parse(calls[0][1].body)).toEqual(JSON.parse(calls[1][1].body));
  });

  it("keeps contact fields hidden while readiness is being checked", () => {
    render(
      <TemplateRequestDialog
        templateId="welcome"
        onClose={jest.fn()}
        source="landing"
        readinessLoading
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking demo availability"
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Demo coming soon")).not.toBeInTheDocument();
  });

  it("starts a new operation only after a definitive send failure", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ code: "send_failed" }),
    });
    render(
      <TemplateRequestDialog
        templateId="welcome"
        onClose={jest.fn()}
        source="marketplace"
        ready
      />
    );
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp number"), {
      target: { value: "+77001234567" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send me this demo" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Start a new request" })
    );
    expect(screen.getByLabelText("WhatsApp number")).toBeEnabled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Send me this demo" }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(JSON.parse(calls[0][1].body).requestId).not.toBe(
      JSON.parse(calls[1][1].body).requestId
    );
  });

  it("does not send invalid contacts or imply an unavailable demo was sent", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ code: "unavailable" }),
    });
    render(
      <TemplateRequestDialog
        templateId="welcome"
        onClose={jest.fn()}
        source="marketplace"
        ready
      />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Send me this demo" }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Check your name");
    fireEvent.change(screen.getByLabelText("Your name"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByLabelText("Work email"), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByLabelText("WhatsApp number"), {
      target: { value: "+77001234567" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send me this demo" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "cannot be sent right now"
      )
    );
    expect(screen.queryByText("Your demo is queued")).not.toBeInTheDocument();
  });
});
