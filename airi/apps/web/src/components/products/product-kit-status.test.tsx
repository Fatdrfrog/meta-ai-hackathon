/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type {
  ProductKitCarouselPart,
  ProductKitOrderFormPart,
  ProductKitRecord,
} from "@/lib/products/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { KitStatus, keptLine, kitPartViews } from "./product-kit-status";

// A kit's status: one row per part, each with its own next step.

const WS = "workspace-1";

const form = (
  overrides: Partial<ProductKitOrderFormPart> = {}
): ProductKitOrderFormPart => ({
  state: "ready",
  flowId: "flow-1",
  flowName: "Order form · 2 Nov 09:14",
  productCount: 7,
  error: null,
  ...overrides,
});

const carousel = (
  overrides: Partial<ProductKitCarouselPart> = {}
): ProductKitCarouselPart => ({
  state: "submitted",
  templateId: "tpl-1",
  templateName: "products_20261102_041405",
  cardCount: 7,
  metaStatus: "PENDING",
  metaReason: null,
  approvedAt: null,
  error: null,
  ...overrides,
});

const kit = (parts: ProductKitRecord["parts"]): ProductKitRecord => ({
  id: "kit-1",
  createdAt: "2026-11-02T04:14:05.000Z",
  language: "kk",
  productIds: ["p1", "p2"],
  importId: null,
  parts,
  status: "waiting_for_meta",
  pricesChanged: false,
});

function renderStatus(
  record: ProductKitRecord,
  props: Partial<Parameters<typeof KitStatus>[0]> = {}
) {
  const onRetry = jest.fn();
  render(
    <KitStatus
      workspaceId={WS}
      kit={record}
      remaking={null}
      refusal={null}
      onRetry={onRetry}
      {...props}
    />
  );
  return { onRetry };
}

const row = (name: string) =>
  screen.getByText(name, { selector: "span" }).closest("li")!;

describe("the order form's row", () => {
  it("is published, named, with WhatsApp Flows next", () => {
    renderStatus(kit({ orderForm: form() }));

    const formRow = row("Order form");
    expect(within(formRow).getByText("Ready")).toBeInTheDocument();
    expect(
      within(formRow).getByText(
        "Published on WhatsApp as “Order form · 2 Nov 09:14”, with 7 products to tick."
      )
    ).toBeInTheDocument();
    expect(
      within(formRow).getByRole("link", { name: "Open WhatsApp Flows" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/messengers/whatsapp-flows");
  });

  it("is a draft when Meta wouldn't publish it", () => {
    renderStatus(kit({ orderForm: form({ state: "draft" }) }));

    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Meta didn't publish it, so it's saved as a draft. Publish it in WhatsApp Flows."
      )
    ).toBeInTheDocument();
  });

  it("says why it wasn't made, and tries only it again", () => {
    const { onRetry } = renderStatus(
      kit({
        orderForm: form({
          state: "failed",
          flowId: null,
          error: { code: "meta_refused", message: "Flow name is too long" },
        }),
        carousel: carousel(),
      })
    );

    const formRow = row("Order form");
    expect(within(formRow).getByText("Not made")).toBeInTheDocument();
    expect(
      within(formRow).getByText("Meta refused it: Flow name is too long")
    ).toBeInTheDocument();
    fireEvent.click(within(formRow).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledWith("orderForm");
    expect(
      screen.getByText("The carousel stays with Meta.")
    ).toBeInTheDocument();
  });

  it("shows as making while it's made again, keeping its Try again where the focus is", () => {
    const { onRetry } = renderStatus(
      kit({ orderForm: form({ state: "failed", error: null }) }),
      { remaking: "orderForm" }
    );

    expect(screen.getByText("Making")).toBeInTheDocument();
    expect(screen.getByText("Publishing the order form…")).toBeInTheDocument();
    // Still there (a removed button would drop the keyboard's focus), but
    // it can't be pressed again until the part is made.
    const again = screen.getByRole("button", { name: "Try again" });
    expect(again).toHaveAttribute("aria-disabled", "true");
    expect(again).not.toBeDisabled();
    fireEvent.click(again);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("the carousel's row", () => {
  const templates =
    "/panel/w/workspace-1/messengers/whatsapp-templates?template=products_20261102_041405";

  it("waits for Meta, with the template in Templates", () => {
    renderStatus(kit({ carousel: carousel() }));

    expect(screen.getByText("With Meta")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Meta is checking it. That usually takes minutes, and at most 24 hours. This page updates on its own."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in Templates" })
    ).toHaveAttribute("href", templates);
  });

  it("is approved, at a time on the owner's clock", () => {
    renderStatus(
      kit({
        carousel: carousel({
          metaStatus: "APPROVED",
          approvedAt: "2026-11-02T04:21:00.000Z",
        }),
      })
    );

    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(
      screen.getByText(
        /^Meta approved it at \d{2}:\d{2}\. Send it from a scenario or a bulk campaign\.$/
      )
    ).toBeInTheDocument();
  });

  it("is not approved, with Meta's reason, to edit or make again", () => {
    const { onRetry } = renderStatus(
      kit({
        carousel: carousel({
          metaStatus: "REJECTED",
          metaReason: "invalid format",
        }),
      })
    );

    expect(screen.getByText("Not approved")).toBeInTheDocument();
    expect(
      screen.getByText("Meta didn't approve it: invalid format")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Edit it in Templates" })
    ).toHaveAttribute("href", templates);
    fireEvent.click(screen.getByRole("button", { name: "Make it again" }));
    expect(onRetry).toHaveBeenCalledWith("carousel");
  });

  it("is paused, turned off, or past the template limit, each in its own words", () => {
    const { unmount } = render(
      <KitStatus
        workspaceId={WS}
        kit={kit({ carousel: carousel({ metaStatus: "PAUSED" }) })}
        remaking={null}
        refusal={null}
        onRetry={jest.fn()}
      />
    );
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Meta paused it because buyers reported or blocked it. It comes back on its own if quality improves."
      )
    ).toBeInTheDocument();
    unmount();

    const turnedOff = renderStatus(
      kit({ carousel: carousel({ metaStatus: "DISABLED" }) })
    );
    expect(screen.getByText("Turned off")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Meta turned it off. Edit it in Templates and send it again."
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make it again" }));
    expect(turnedOff.onRetry).toHaveBeenCalledWith("carousel");
  });

  it("says when the account has as many templates as Meta allows", () => {
    renderStatus(kit({ carousel: carousel({ metaStatus: "LIMIT_EXCEEDED" }) }));

    expect(screen.getByText("Template limit")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your WhatsApp account has as many templates as Meta allows. Delete ones you don't use in Templates, then try again."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in Templates" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Make it again" })).toBeVisible();
  });

  it("says Meta refused it for the template limit, with Templates to free one", () => {
    renderStatus(
      kit({
        carousel: carousel({
          state: "failed",
          templateId: null,
          templateName: null,
          metaStatus: null,
          error: { code: "template_limit", message: "maximum number" },
        }),
      })
    );

    expect(
      screen.getByText(
        "Your WhatsApp account has as many templates as Meta allows. Delete ones you don't use in Templates, then try again."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open in Templates" })
    ).toHaveAttribute(
      "href",
      "/panel/w/workspace-1/messengers/whatsapp-templates"
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("says the storage is full, with Assets, and keeps the order form", () => {
    renderStatus(
      kit({
        orderForm: form(),
        carousel: carousel({
          state: "failed",
          templateId: null,
          templateName: null,
          metaStatus: null,
          error: { code: "storage_full", message: null },
        }),
      })
    );

    const carouselRow = row("Carousel");
    expect(within(carouselRow).getByText("Not made")).toBeInTheDocument();
    expect(
      within(carouselRow).getByText(
        "Your company's media storage is full. Delete some files in Assets, then try again."
      )
    ).toBeInTheDocument();
    expect(
      within(carouselRow).getByRole("link", { name: "Open Assets" })
    ).toHaveAttribute("href", "/panel/w/workspace-1/assets");
    expect(
      within(carouselRow).getByRole("button", { name: "Try again" })
    ).toBeVisible();
    expect(screen.getByText("The order form stays ready.")).toBeInTheDocument();
  });

  it("says why else it wasn't made: Meta's words, too long, too few photos", () => {
    for (const [error, line] of [
      [
        { code: "meta_refused", message: "Invalid parameter" },
        "Meta refused it: Invalid parameter",
      ],
      [{ code: "timed_out", message: null }, "This took too long. Try again."],
      [{ code: "failed", message: null }, "That didn't work. Try again."],
      [
        { code: "not_enough_products", message: null },
        "These products don't have photos to put on the cards.",
      ],
    ] as const) {
      const [view] = kitPartViews(
        WS,
        kit({ carousel: carousel({ state: "failed", error }) })
      );
      expect(view!.line).toBe(line);
    }
  });

  it("was skipped for too few photos, with nothing to do", () => {
    renderStatus(
      kit({
        orderForm: form(),
        carousel: carousel({
          state: "skipped",
          templateId: null,
          cardCount: 0,
          metaStatus: null,
          error: { code: "not_enough_products", message: null },
        }),
      })
    );

    const carouselRow = row("Carousel");
    expect(
      within(carouselRow).getByText(
        "These products don't have photos to put on the cards."
      )
    ).toBeInTheDocument();
    expect(within(carouselRow).queryByRole("button")).toBeNull();
    expect(screen.queryByText("The order form stays ready.")).toBeNull();
  });

  it("is being made", () => {
    renderStatus(
      kit({ carousel: carousel({ state: "making", templateId: null }) })
    );

    expect(
      screen.getByText("Making 7 cards and sending them to Meta…")
    ).toBeInTheDocument();
  });

  it("is checked with Meta after a slow answer, with nothing to press meanwhile", () => {
    const checking = kit({
      orderForm: form(),
      carousel: carousel({
        state: "checking",
        templateId: null,
        metaStatus: null,
      }),
    });
    renderStatus(checking);

    const carouselRow = row("Carousel");
    expect(within(carouselRow).getByText("Checking")).toBeInTheDocument();
    expect(
      within(carouselRow).getByText(
        "Checking with Meta… It was slow to answer, so Airi is looking for the carousel there. This page updates on its own."
      )
    ).toBeInTheDocument();
    // No Try again: it would send Meta a second carousel.
    expect(within(carouselRow).queryByRole("button")).toBeNull();
    expect(within(carouselRow).queryByRole("link")).toBeNull();
    const views = kitPartViews(WS, checking);
    expect(views.find(view => view.part === "carousel")).toMatchObject({
      listChip: { label: "Carousel checking", tone: "neutral" },
      holds: false,
    });
    expect(keptLine(views)).toBeNull();
  });
});

test("a refusal to make a part again shows under its row", () => {
  renderStatus(kit({ carousel: carousel({ state: "failed", error: null }) }), {
    refusal: {
      part: "carousel",
      line: "Connect your WhatsApp number to make these.",
    },
  });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Connect your WhatsApp number to make these."
  );
});

test("nothing is said to be kept when both parts hold, or neither does", () => {
  expect(
    keptLine(kitPartViews(WS, kit({ orderForm: form(), carousel: carousel() })))
  ).toBeNull();
  expect(
    keptLine(
      kitPartViews(
        WS,
        kit({
          orderForm: form({ state: "failed" }),
          carousel: carousel({ state: "failed" }),
        })
      )
    )
  ).toBeNull();
});
