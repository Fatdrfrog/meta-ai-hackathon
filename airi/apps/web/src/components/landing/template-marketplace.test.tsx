/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TemplateMarketplace } from "./template-marketplace";

let mockQuery = "";
let mockLocale = "en";
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockQuery),
  usePathname: () => "/whatsapp-templates",
  useRouter: () => ({ replace: mockReplace }),
}));
jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTranslations:
    (namespace?: string) =>
    (key: string, values?: Record<string, string | number>) => {
      const messages = jest.requireActual(
        `../../../messages/${mockLocale}.json`
      );
      const value = (namespace ? `${namespace}.${key}` : key)
        .split(".")
        .reduce<unknown>(
          (current, part) => (current as Record<string, unknown>)[part],
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
  TemplatePreview: () => <div>Sample preview</div>,
}));
jest.mock("./template-request-dialog", () => ({
  TemplateRequestDialog: ({
    templateId,
    ready,
    readinessUnavailable,
    onClose,
  }: {
    templateId: string | null;
    ready: boolean;
    readinessUnavailable: boolean;
    onClose: () => void;
  }) =>
    templateId ? (
      <div
        role="dialog"
        data-ready={String(ready)}
        data-unavailable={String(readinessUnavailable)}
      >
        {templateId}
        <button onClick={onClose}>Close preview</button>
      </div>
    ) : null,
}));

describe("Public template marketplace", () => {
  beforeEach(() => {
    mockQuery = "";
    mockLocale = "en";
    mockReplace.mockClear();
    global.fetch = jest.fn();
  });

  it.each(["en", "ru", "kz"])(
    "links every example and each language version for crawlers in %s",
    locale => {
      mockLocale = locale;
      render(<TemplateMarketplace readyTemplateIds={[]} />);
      const links = screen
        .getAllByRole("heading", { level: 2 })
        .map(heading => within(heading).getByRole("link"));
      expect(links).toHaveLength(62);
      for (const link of links) {
        expect(link.getAttribute("href")).toMatch(
          new RegExp(
            `^/whatsapp-templates/[a-z-]+${locale === "en" ? "$" : `\\?locale=${locale}$`}`
          )
        );
      }
      expect(screen.getByRole("link", { name: "English" })).toHaveAttribute(
        "href",
        "/whatsapp-templates"
      );
      expect(screen.getByRole("link", { name: "Русский" })).toHaveAttribute(
        "href",
        "/whatsapp-templates?locale=ru"
      );
      expect(screen.getByRole("link", { name: "Қазақша" })).toHaveAttribute(
        "href",
        "/whatsapp-templates?locale=kz"
      );
    }
  );

  it("renders the catalog immediately while availability loads independently", async () => {
    let resolveAvailability: (value: unknown) => void = () => {};
    (global.fetch as jest.Mock).mockImplementation(
      () =>
        new Promise(resolve => {
          resolveAvailability = resolve;
        })
    );
    render(<TemplateMarketplace />);
    expect(screen.getAllByRole("article")).toHaveLength(62);
    expect(screen.getAllByText("Checking demo availability…")).toHaveLength(62);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/landing/template-request?locale=en",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    resolveAvailability({
      ok: true,
      json: async () => ({
        readyTemplateIds: ["welcome"],
        unavailableTemplateIds: [],
      }),
    });
    await waitFor(() =>
      expect(screen.getByText("Ready to send")).toBeVisible()
    );
    expect(screen.getAllByRole("article")).toHaveLength(62);
  });

  it("keeps browsing available when the availability request fails", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("Offline"));
    render(<TemplateMarketplace />);
    await waitFor(() =>
      expect(
        screen.getAllByText("Demo availability is temporarily unavailable")
      ).toHaveLength(62)
    );
    expect(screen.getAllByRole("article")).toHaveLength(62);
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it.each(["en", "ru", "kz"])(
    "distinguishes a temporary Flow outage from ready and unprepared demos in %s",
    async locale => {
      mockLocale = locale;
      const messages = jest.requireActual(`../../../messages/${locale}.json`);
      const labels = messages.LandingDemo.templates;
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          readyTemplateIds: ["welcome"],
          unavailableTemplateIds: ["course-enrollment"],
        }),
      });
      render(<TemplateMarketplace />);
      await waitFor(() =>
        expect(screen.getByText(labels.availabilityUnavailable)).toBeVisible()
      );
      const readyCard = screen
        .getByRole("heading", { name: labels.catalog.welcome.title })
        .closest("article")!;
      expect(within(readyCard).getByText(labels.ready)).toBeVisible();
      fireEvent.click(within(readyCard).getByRole("button"));
      expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "true");
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-unavailable",
        "false"
      );
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

      const outageCard = screen
        .getByRole("heading", {
          name: labels.catalog["course-enrollment"].title,
        })
        .closest("article")!;
      expect(
        within(outageCard).queryByText(labels.comingSoon)
      ).not.toBeInTheDocument();
      fireEvent.click(within(outageCard).getByRole("button"));
      expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "false");
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-unavailable",
        "true"
      );
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

      const pendingCard = screen
        .getByRole("heading", {
          name: labels.catalog["order-confirmation"].title,
        })
        .closest("article")!;
      expect(within(pendingCard).getByText(labels.comingSoon)).toBeVisible();
      fireEvent.click(within(pendingCard).getByRole("button"));
      expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "false");
      expect(screen.getByRole("dialog")).toHaveAttribute(
        "data-unavailable",
        "false"
      );
    }
  );

  it("fails closed when one demo is reported as both ready and unavailable", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        readyTemplateIds: ["welcome"],
        unavailableTemplateIds: ["welcome"],
      }),
    });
    render(<TemplateMarketplace />);
    await waitFor(() =>
      expect(
        screen.getAllByText("Demo availability is temporarily unavailable")
      ).toHaveLength(62)
    );
    expect(screen.queryByText("Ready to send")).not.toBeInTheDocument();
  });

  it("renders filtered URL results, meaningful industry labels and selected demo readiness", () => {
    mockQuery = "industry=retail&goal=retain&format=image";
    render(<TemplateMarketplace readyTemplateIds={["repeat-purchase"]} />);
    expect(screen.getAllByRole("article")).toHaveLength(5);
    expect(
      screen.getByRole("option", { name: "Retail & e-commerce" })
    ).toBeVisible();
    const request = screen.getByRole("button", { name: /Get .* on WhatsApp/ });
    expect(request).toHaveAttribute("data-variant", "secondary");
    expect(request.querySelector(".btn-push-front")).toBeNull();
    fireEvent.click(request);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "true");
    expect(screen.getByRole("dialog")).toHaveTextContent("repeat-purchase");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps filters shareable while preserving unrelated query parameters", () => {
    mockQuery = "utm_source=landing";
    render(<TemplateMarketplace readyTemplateIds={[]} />);
    fireEvent.change(screen.getByLabelText("Industry"), {
      target: { value: "education" },
    });
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/whatsapp-templates?utm_source=landing&industry=education",
      { scroll: false }
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "course" },
    });
    fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/whatsapp-templates?utm_source=landing&q=course",
      { scroll: false }
    );
  });

  it("shows an empty state and clears only catalog filters", () => {
    mockQuery = "q=nevermatches&format=text&utm_source=landing";
    render(<TemplateMarketplace readyTemplateIds={[]} />);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "No matching templates" })
    ).toBeVisible();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear filters" })[0]
    );
    expect(mockReplace).toHaveBeenLastCalledWith(
      "/whatsapp-templates?utm_source=landing",
      { scroll: false }
    );
  });

  it("syncs the search box when the URL changes through navigation", () => {
    const { rerender } = render(<TemplateMarketplace readyTemplateIds={[]} />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "draft" },
    });
    mockQuery = "q=birthday";
    rerender(<TemplateMarketplace readyTemplateIds={[]} />);
    expect(screen.getByRole("searchbox")).toHaveValue("birthday");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it.each(["en", "ru", "kz"])(
    "browses by a localized use case in %s",
    locale => {
      mockLocale = locale;
      mockQuery = "useCase=contacts&locale=ru&utm_source=landing";
      const labels = jest.requireActual(`../../../messages/${locale}.json`)
        .LandingDemo.templates;
      render(<TemplateMarketplace readyTemplateIds={[]} />);
      expect(screen.getAllByRole("article")).toHaveLength(6);
      expect(screen.getByLabelText(labels.useCase)).toHaveValue("contacts");
      for (const card of screen.getAllByRole("article"))
        expect(within(card).getByText(labels.useCases.contacts)).toBeVisible();
      fireEvent.change(screen.getByLabelText(labels.useCase), {
        target: { value: "learning" },
      });
      expect(mockReplace).toHaveBeenLastCalledWith(
        "/whatsapp-templates?useCase=learning&locale=ru&utm_source=landing",
        { scroll: false }
      );
      fireEvent.click(
        screen.getByRole("button", { name: labels.resetFilters })
      );
      expect(mockReplace).toHaveBeenLastCalledWith(
        "/whatsapp-templates?locale=ru&utm_source=landing",
        { scroll: false }
      );
    }
  );

  it("shows the detailed use case and ranks the same job above broad industry matches", () => {
    render(
      <TemplateMarketplace templateId="service-summary" readyTemplateIds={[]} />
    );
    expect(screen.getByText("Service updates")).toBeVisible();
    const related = screen.getByRole("region", {
      name: "Similar templates",
    });
    expect(
      within(related)
        .getAllByRole("listitem")
        .map(item => within(item).getByRole("link").getAttribute("href"))
    ).toEqual([
      "/whatsapp-templates/repair-progress",
      "/whatsapp-templates/service-completed",
      "/whatsapp-templates/order-confirmation",
    ]);
  });

  it("shows all new formats and translated titles when the locale changes", () => {
    mockQuery = "format=document";
    const { rerender } = render(<TemplateMarketplace readyTemplateIds={[]} />);
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Quote" })).toBeVisible();
    expect(screen.getByRole("option", { name: "PDF" })).toBeVisible();
    mockLocale = "ru";
    mockQuery = "";
    rerender(<TemplateMarketplace readyTemplateIds={[]} />);
    expect(screen.getAllByRole("article")).toHaveLength(62);
    expect(
      screen.queryByRole("heading", { name: "Quote" })
    ).not.toBeInTheDocument();
    const russian = jest.requireActual("../../../messages/ru.json");
    expect(
      screen.getByRole("heading", {
        name: russian.LandingDemo.templates.catalog["quote-ready"].title,
      })
    ).toBeVisible();
    mockLocale = "kz";
    rerender(<TemplateMarketplace readyTemplateIds={[]} />);
    const kazakh = jest.requireActual("../../../messages/kz.json");
    expect(screen.getAllByRole("article")).toHaveLength(62);
    expect(
      screen.getByRole("heading", {
        name: kazakh.LandingDemo.templates.catalog["quote-ready"].title,
      })
    ).toBeVisible();
  });

  it.each(["en", "ru", "kz"])(
    "shows a full detail example with related links and the shared demo action in %s",
    locale => {
      mockLocale = locale;
      mockQuery = "q=nevermatches&industry=finance";
      const messages = jest.requireActual(`../../../messages/${locale}.json`);
      const labels = messages.LandingDemo.templates;
      render(
        <TemplateMarketplace
          templateId="quote-ready"
          readyTemplateIds={["quote-ready"]}
        />
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        labels.catalog["quote-ready"].title
      );
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      expect(screen.getByText(labels.formats.document)).toBeVisible();
      const related = screen.getByRole("region", {
        name: labels.seo.relatedTitle,
      });
      expect(within(related).getAllByRole("listitem")).toHaveLength(3);
      expect(screen.getByRole("link", { name: "Қазақша" })).toHaveAttribute(
        "href",
        "/whatsapp-templates/quote-ready?locale=kz"
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: labels.getTemplateLabel.replace(
            "{title}",
            labels.catalog["quote-ready"].title
          ),
        })
      );
      expect(screen.getByRole("dialog")).toHaveTextContent("quote-ready");
      expect(screen.getByRole("dialog")).toHaveAttribute("data-ready", "true");
      expect(global.fetch).not.toHaveBeenCalled();
    }
  );
});
