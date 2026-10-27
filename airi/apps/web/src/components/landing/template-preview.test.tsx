/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  getPublicTemplate,
  type PublicTemplate,
} from "@/lib/landing/public-template-catalog";
import { TemplatePreview } from "./template-preview";
import { installMatchMedia } from "@/test-support/dom-test-utils";

let mockLocale = "en";
jest.mock("next-intl", () => ({
  useTranslations: (namespace?: string) => (key: string) => {
    const messages = jest.requireActual(`../../../messages/${mockLocale}.json`);
    return (namespace ? `${namespace}.${key}` : key)
      .split(".")
      .reduce<unknown>(
        (value, part) => (value as Record<string, unknown>)[part],
        messages
      );
  },
}));
jest.mock("next/image", () =>
  jest.requireActual("./landing-test-utils").nextImageMock()
);

describe("Public template artwork", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    mockLocale = "en";
    installMatchMedia(() => true);
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it.each([
    ["seasonal-offer", "/templates/seasonal-offer.png"],
    ["repeat-purchase", "/templates/repeat-purchase.png"],
    ["shipping-update", "/templates/shipping-update.png"],
    ["birthday-offer", "/templates/birthday-offer.png"],
  ])("shows attached artwork for %s", (id, path) => {
    const { container } = render(
      <TemplatePreview template={getPublicTemplate(id)!} />
    );
    expect(container.querySelector("img")).toHaveAttribute("src", path);
    expect(
      screen.queryByText("Your brand image goes here")
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "shows every carousel image in order (compact=%s)",
    compact => {
      const { container } = render(
        <TemplatePreview
          template={getPublicTemplate("back-in-stock")!}
          compact={compact}
        />
      );
      expect(
        Array.from(container.querySelectorAll("img"), image =>
          image.getAttribute("src")
        )
      ).toEqual([
        "/templates/back-in-stock-01.png",
        "/templates/back-in-stock-02.png",
        "/templates/back-in-stock-03.png",
      ]);
    }
  );

  it.each([
    ["en", "Previous product", "Next product"],
    ["ru", "Предыдущий товар", "Следующий товар"],
    ["kz", "Алдыңғы тауар", "Келесі тауар"],
  ])(
    "supports keyboard carousel navigation in %s",
    async (locale, previousLabel, nextLabel) => {
      mockLocale = locale;
      const user = userEvent.setup();
      render(
        <TemplatePreview template={getPublicTemplate("back-in-stock")!} />
      );
      const viewport = screen.getByTestId("carousel-cards-viewport");
      Object.defineProperties(viewport, {
        scrollWidth: { value: 824, configurable: true },
        clientWidth: { value: 268, configurable: true },
      });
      Object.defineProperty(viewport.firstElementChild!, "offsetWidth", {
        value: 260,
      });
      viewport.scrollBy = jest.fn((options?: ScrollToOptions | number) => {
        viewport.scrollLeft +=
          typeof options === "object" ? (options.left ?? 0) : (options ?? 0);
        fireEvent.scroll(viewport);
      });
      act(() => window.dispatchEvent(new Event("resize")));
      const previous = screen.getByRole("button", { name: previousLabel });
      const next = screen.getByRole("button", { name: nextLabel });
      expect(previous).toBeDisabled();
      await user.tab();
      expect(next).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(viewport.scrollLeft).toBeGreaterThan(0);
      expect(previous).toBeEnabled();
      previous.focus();
      await user.keyboard("{Enter}");
      expect(viewport.scrollLeft).toBe(0);
      expect(previous).toBeDisabled();
    }
  );

  it("keeps an unprepared media example visibly marked", () => {
    render(
      <TemplatePreview
        template={{
          ...getPublicTemplate("seasonal-offer")!,
          imagePath: undefined,
        }}
      />
    );
    expect(screen.getByText("Your brand image goes here")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    {
      locale: "en",
      prefix: "airi.chat demo: welcome",
      disclaimer: "Fictional example",
      footer: "To unsubscribe: samat@airi.chat",
    },
    {
      locale: "ru",
      prefix: "Демо airi.chat: приветствие",
      disclaimer: "Вымышленный пример",
      footer: "Для отказа от сообщений: samat@airi.chat",
    },
    {
      locale: "kz",
      prefix: "airi.chat демосы: сәлемдесу",
      disclaimer: "Ойдан шығарылған мысал",
      footer: "Хабарламадан бас тарту: samat@airi.chat",
    },
  ])("shows the original approved demo label and footer in $locale", item => {
    mockLocale = item.locale;
    render(<TemplatePreview template={getPublicTemplate("welcome")!} />);
    expect(screen.getByText(item.prefix).tagName).toBe("STRONG");
    expect(screen.getByText(item.disclaimer).tagName).toBe("EM");
    expect(screen.getByText(item.footer)).toHaveClass("previewMessageFooter");
  });

  it.each([
    {
      locale: "en",
      titles: [
        "Terra vase · demo product",
        "Mora baskets · demo products",
        "Lino throw · demo product",
      ],
      button: "Explore airi.chat",
    },
    {
      locale: "ru",
      titles: [
        "Ваза Terra · пример товара",
        "Корзины Mora · примеры товаров",
        "Плед Lino · пример товара",
      ],
      button: "Открыть airi.chat",
    },
    {
      locale: "kz",
      titles: [
        "Terra вазасы · демо тауар",
        "Mora себеттері · демо тауарлар",
        "Lino пледі · демо тауар",
      ],
      button: "airi.chat ашу",
    },
  ])("keeps the original approved carousel card content in $locale", item => {
    mockLocale = item.locale;
    const { container } = render(
      <TemplatePreview template={getPublicTemplate("back-in-stock")!} />
    );
    const cards = container.querySelectorAll(".carouselCard");
    expect(cards).toHaveLength(3);
    item.titles.forEach((title, index) => {
      expect(cards[index].querySelector("strong")).toHaveTextContent(title);
      expect(cards[index].querySelector(".previewButton")).toHaveTextContent(
        item.button
      );
    });
    expect(container.querySelectorAll(".previewButton")).toHaveLength(3);
    expect(container.querySelector(".previewMessageFooter")).toBeNull();
    expect(container.textContent?.match(/samat@airi\.chat/g)).toHaveLength(1);
  });

  it("renders WhatsApp markers as safe text and shows every illustrative button", () => {
    const { container } = render(
      <TemplatePreview
        template={
          {
            ...getPublicTemplate("welcome")!,
            preview: {
              body: "*Hello Alex*\n_Choose a demo_ ~old price~ ```DEMO-001``` <img src=x onerror=alert(1)>",
              footer: "Fictional sample only",
              buttons: [
                { type: "QUICK_REPLY", text: "Show choices" },
                {
                  type: "URL",
                  text: "Visit airi.chat",
                  url: "https://www.airi.chat/",
                },
                { type: "FLOW", text: "Try demo" },
              ],
            },
          } as PublicTemplate
        }
      />
    );
    expect(container.querySelector("strong")?.textContent).toBe("airi.chat");
    expect(screen.getByText("Hello Alex").tagName).toBe("STRONG");
    expect(screen.getByText("Choose a demo").tagName).toBe("EM");
    expect(screen.getByText("old price").tagName).toBe("S");
    expect(screen.getByText("DEMO-001").tagName).toBe("CODE");
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Fictional sample only")).toBeVisible();
    expect(screen.getByText("Show choices")).toBeVisible();
    expect(screen.getByText("Visit airi.chat")).toBeVisible();
    expect(screen.getByText("Try demo")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links a document without embedding or loading the PDF", () => {
    const { container } = render(
      <TemplatePreview
        template={
          {
            ...getPublicTemplate("welcome")!,
            format: "document",
            documentPath: "/templates/airi-demo-guide.pdf",
            documentFilename: "airi-demo-guide.pdf",
          } as PublicTemplate
        }
      />
    );
    const attachment = screen.getByRole("link", {
      name: /airi-demo-guide.pdf/,
    });
    expect(attachment).toHaveAttribute(
      "href",
      "/templates/airi-demo-guide.pdf"
    );
    expect(attachment).toHaveAttribute("rel", "noopener noreferrer");
    expect(container.querySelector("iframe,embed,object")).toBeNull();
  });

  it("does not turn unsafe document URLs into clickable attachments", () => {
    render(
      <TemplatePreview
        template={
          {
            ...getPublicTemplate("welcome")!,
            format: "document",
            documentPath: "javascript:alert(1)",
            documentFilename: "fictional-guide.pdf",
          } as PublicTemplate
        }
      />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("fictional-guide.pdf")).toBeVisible();
  });

  it("uses native video controls with no eager media fetch or autoplay", () => {
    const { container } = render(
      <TemplatePreview
        template={
          {
            ...getPublicTemplate("welcome")!,
            format: "video",
            videoPath: "/templates/airi-demo-tour.mp4",
            videoPosterPath: "/templates/seasonal-offer.png",
          } as PublicTemplate
        }
      />
    );
    const video = container.querySelector("video");
    expect(video).toHaveAttribute("src", "/templates/airi-demo-tour.mp4");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).toHaveAttribute("poster", "/templates/seasonal-offer.png");
  });

  it("shows a fictional location pin and address without loading an external map", () => {
    const { container } = render(
      <TemplatePreview
        template={
          {
            ...getPublicTemplate("welcome")!,
            format: "location",
            location: {
              name: "Demo branch",
              address: "Fictional address for demonstration",
              latitude: 43.2389,
              longitude: 76.8897,
            },
          } as PublicTemplate
        }
      />
    );
    expect(screen.getByText("Demo branch")).toBeVisible();
    expect(
      screen.getByText("Fictional address for demonstration")
    ).toBeVisible();
    expect(screen.getByText("43.23890, 76.88970")).toBeVisible();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps each carousel card's formatted sample text and buttons together", () => {
    const { container } = render(
      <TemplatePreview
        template={{
          ...getPublicTemplate("back-in-stock")!,
          carouselPreviews: [
            {
              body: "*First sample item*",
              buttons: [{ type: "QUICK_REPLY", text: "Choose first" }],
            },
            {
              body: "*Second sample item*",
              buttons: [{ type: "QUICK_REPLY", text: "Choose second" }],
            },
            {
              body: "*Third sample item*",
              buttons: [
                {
                  type: "URL",
                  text: "Explore third",
                  url: "https://www.airi.chat/",
                },
              ],
            },
          ],
        }}
      />
    );
    const cards = container.querySelectorAll(".carouselCard");
    ["First sample item", "Second sample item", "Third sample item"].forEach(
      (text, index) => {
        expect(cards[index].querySelector("strong")).toHaveTextContent(text);
      }
    );
    ["Choose first", "Choose second", "Explore third"].forEach(
      (text, index) => {
        expect(cards[index]).toHaveTextContent(text);
      }
    );
  });

  it("replaces a failed video preview and permits a different clip afterward", () => {
    const template = {
      ...getPublicTemplate("welcome")!,
      format: "video",
      videoPath: "/templates/first-demo.mp4",
    } as PublicTemplate;
    const { container, rerender } = render(
      <TemplatePreview template={template} />
    );
    fireEvent.error(container.querySelector("video")!);
    expect(container.querySelector("video")).toBeNull();
    rerender(
      <TemplatePreview
        template={{ ...template, videoPath: "/templates/next-demo.mp4" }}
      />
    );
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      "/templates/next-demo.mp4"
    );
  });
});
