/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState, type ReactNode } from "react";
import type {
  ScenarioActionAttachment,
  ScenarioWhatsAppCarouselCard,
} from "@icecore/scenario-contracts";
import {
  ServiceMessageCarouselControls,
  ServiceMessageCarouselFields,
} from "./service-message-carousel-fields";

jest.mock("next-intl", () => ({
  useFormatter: () => ({
    number: (value: number, options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en", options).format(value),
  }),
  // Values follow the key so labels that carry a number stay distinct.
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values ? `${key} ${Object.values(values).join(".")}` : key,
}));

jest.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
}));

const card = (id: string, bodyText = "") => ({
  id,
  media: { mediaType: "image" as const, url: "" },
  bodyText,
  interaction: {
    kind: "quick_replies" as const,
    options: [{ id: `${id}-option`, label: "Choice" }],
  },
});

describe("ServiceMessageCarouselFields", () => {
  it("preserves card edits and other uploads when media completes together", async () => {
    const finish: Array<(value: ScenarioActionAttachment) => void> = [];
    const upload = jest.fn(
      () =>
        new Promise<ScenarioActionAttachment>(resolve => {
          finish.push(resolve);
        })
    );
    let latest: ScenarioWhatsAppCarouselCard[] = [];
    function Harness() {
      const [cards, setCards] = useState<ScenarioWhatsAppCarouselCard[]>([
        card("one"),
        card("two"),
      ]);
      return (
        <ServiceMessageCarouselFields
          cards={cards}
          upload={upload}
          createOptionId={() => "new"}
          onChange={next => {
            latest = next;
            setCards(next);
          }}
        />
      );
    }
    render(<Harness />);
    for (const input of document.querySelectorAll('input[type="file"]')) {
      fireEvent.change(input, {
        target: {
          files: [new File(["image"], "new.png", { type: "image/png" })],
        },
      });
    }
    fireEvent.change(
      screen.getByLabelText("whatsappServiceCarouselCardTextLabel 1"),
      {
        target: { value: "New caption" },
      }
    );
    await act(async () => {
      finish[0]({ mediaType: "image", url: "https://cdn.example/one.png" });
      finish[1]({ mediaType: "image", url: "https://cdn.example/two.png" });
    });
    expect(latest[0]).toMatchObject({
      bodyText: "New caption",
      media: { url: "https://cdn.example/one.png" },
    });
    expect(latest[1].media.url).toBe("https://cdn.example/two.png");
  });

  it("hides card removal at the two-card minimum", () => {
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two")]}
        createOptionId={() => "option"}
        onChange={jest.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "whatsappServiceDeleteCard" })
    ).toBeNull();
  });

  it("preserves multiline carousel body copy without changing another card", () => {
    const onChange = jest.fn();
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two")]}
        createOptionId={() => "option"}
        onChange={onChange}
      />
    );

    const body = screen.getByLabelText(
      "whatsappServiceCarouselCardTextLabel 1"
    );
    expect(body.tagName).toBe("TEXTAREA");
    const copy =
      "A title that can wrap across the card\nA second line for details";
    fireEvent.change(body, { target: { value: copy } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...card("one"), bodyText: copy },
      card("two"),
    ]);
  });

  it("shows and enforces the carousel card copy limit in the editor", () => {
    render(
      <ServiceMessageCarouselFields
        cards={[card("one", "Card copy"), card("two")]}
        createOptionId={() => "option"}
        fieldErrors={
          new Map([
            [
              "cards.0.bodyText",
              { code: "body_too_long", message: "Card copy is too long" },
            ],
          ])
        }
        onChange={jest.fn()}
      />
    );

    const body = screen.getByLabelText(
      "whatsappServiceCarouselCardTextLabel 1"
    );
    expect(body).toHaveAttribute("maxlength", "160");
    expect(body).toHaveAttribute("data-sm-field", "cards.0.bodyText");
    expect(screen.getByText("9/160")).toBeInTheDocument();
    expect(screen.getByText("Card copy is too long")).toBeInTheDocument();
  });

  it("removes cards above the minimum without sending pointer events to the graph", () => {
    const onChange = jest.fn();
    const onGraphPointerDown = jest.fn();
    render(
      <div onPointerDown={onGraphPointerDown}>
        <ServiceMessageCarouselFields
          cards={[card("one"), card("two"), card("three")]}
          createOptionId={() => "option"}
          onChange={onChange}
        />
      </div>
    );

    const remove = screen.getAllByRole("button", {
      name: "whatsappServiceDeleteCard",
    })[0];
    fireEvent.pointerDown(remove);
    expect(onGraphPointerDown).not.toHaveBeenCalled();
    fireEvent.click(remove);
    expect(onChange).toHaveBeenCalledWith([card("two"), card("three")]);
  });

  it("keeps destructive card controls visibly discoverable without hover", () => {
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two"), card("three")]}
        createOptionId={() => "option"}
        onChange={jest.fn()}
      />
    );

    expect(
      screen.getAllByRole("button", { name: "whatsappServiceDeleteCard" })[0]
    ).not.toHaveClass("opacity-0");
  });

  it("renders one carousel-wide control for adding and removing button rows", () => {
    const cards = [card("one"), card("two")].map(current => ({
      ...current,
      interaction: {
        kind: "quick_replies" as const,
        options: [
          { id: `${current.id}-one`, label: "First" },
          { id: `${current.id}-two`, label: "Second" },
        ],
      },
    }));

    render(
      <>
        <ServiceMessageCarouselFields
          cards={cards}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
        <ServiceMessageCarouselControls
          cards={cards}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
      </>
    );

    expect(
      screen.getAllByRole("button", {
        name: "whatsappServiceCarouselAddButtonEveryCard",
      })
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "whatsappServiceCarouselDeleteButtonEveryCard",
      })
    ).toBeInTheDocument();
  });

  it("does not recreate scroll observers while card copy is typed", () => {
    const observe = jest.fn();
    const disconnect = jest.fn();
    const resizeObserver = jest.fn(() => ({ observe, disconnect }));
    const originalResizeObserver = global.ResizeObserver;
    global.ResizeObserver =
      resizeObserver as unknown as typeof global.ResizeObserver;

    try {
      const { rerender } = render(
        <ServiceMessageCarouselFields
          cards={[card("one"), card("two")]}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
      );

      rerender(
        <ServiceMessageCarouselFields
          cards={[card("one", "Typed"), card("two")]}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
      );

      expect(resizeObserver).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      global.ResizeObserver = originalResizeObserver;
    }
  });

  it("updates scroll affordances when carousel children mutate", () => {
    let notifyMutation: MutationCallback | null = null;
    let mutationObserverInstance: MutationObserver | null = null;
    const originalMutationObserver = global.MutationObserver;
    global.MutationObserver = jest.fn((callback: MutationCallback) => {
      const observer = {
        disconnect: jest.fn(),
        observe: jest.fn(),
        takeRecords: jest.fn(() => []),
      } as unknown as MutationObserver;
      notifyMutation = callback;
      mutationObserverInstance = observer;
      return observer;
    }) as unknown as typeof global.MutationObserver;

    try {
      render(
        <ServiceMessageCarouselFields
          cards={[card("one"), card("two")]}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
      );

      const firstCardBody = screen.getByLabelText(
        "whatsappServiceCarouselCardTextLabel 1"
      );
      const scroller = firstCardBody.closest(
        "[data-testid='carousel-cards-viewport']"
      ) as HTMLDivElement;
      const metrics = {
        clientWidth: 200,
        scrollLeft: 0,
        scrollWidth: 200,
      };
      Object.defineProperties(scroller, {
        clientWidth: {
          configurable: true,
          get: () => metrics.clientWidth,
        },
        scrollLeft: {
          configurable: true,
          get: () => metrics.scrollLeft,
          set: (value: number) => {
            metrics.scrollLeft = value;
          },
        },
        scrollWidth: {
          configurable: true,
          get: () => metrics.scrollWidth,
        },
      });

      expect(
        screen.queryByRole("button", {
          name: "whatsappServiceCarouselScrollNext",
        })
      ).toBeNull();

      metrics.scrollWidth = 420;
      scroller.appendChild(document.createElement("div"));
      act(() => {
        notifyMutation?.([], mutationObserverInstance!);
      });

      expect(
        screen.getByRole("button", {
          name: "whatsappServiceCarouselScrollNext",
        })
      ).toBeInTheDocument();

      metrics.scrollLeft = 220;
      fireEvent.scroll(scroller);
      expect(
        screen.getByRole("button", {
          name: "whatsappServiceCarouselScrollPrevious",
        })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: "whatsappServiceCarouselScrollNext",
        })
      ).toBeNull();
    } finally {
      global.MutationObserver = originalMutationObserver;
    }
  });

  it("names every card control by its card and position", () => {
    const linkCard = {
      ...card("two"),
      interaction: { kind: "url" as const, buttonLabel: "Shop", url: "" },
    };
    render(
      <>
        <ServiceMessageCarouselFields
          cards={[card("one"), linkCard, card("three")]}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
        <ServiceMessageCarouselControls
          cards={[card("one"), card("two")]}
          createOptionId={() => "option"}
          onChange={jest.fn()}
        />
      </>
    );

    expect(
      screen.getByRole("textbox", {
        name: "whatsappServiceCarouselCardTextLabel 3",
      })
    ).toHaveAttribute(
      "placeholder",
      "whatsappServiceCarouselCardTextPlaceholder"
    );
    expect(
      screen.getByRole("textbox", {
        name: "whatsappServiceCarouselButtonAria 1.1",
      })
    ).toHaveValue("Choice");
    expect(
      screen.getByRole("textbox", {
        name: "whatsappServiceCarouselButtonAria 2.1",
      })
    ).toHaveValue("Shop");
    expect(
      screen.getByRole("textbox", { name: "whatsappServiceCarouselCardLink 2" })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "whatsappServiceCarouselAddMedia" })
    ).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "whatsappServiceCarouselButtonCount" })
    ).toHaveAccessibleDescription("whatsappServiceCarouselQuickReplies");
  });

  it("does nothing when the active interaction family is selected again", () => {
    const onChange = jest.fn();
    render(
      <ServiceMessageCarouselControls
        cards={[card("one"), card("two")]}
        createOptionId={() => "option"}
        onChange={onChange}
      />
    );

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "whatsappServiceCarouselQuickReplies",
      })
    );

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ServiceMessageCarouselFields branch handles", () => {
  function renderHandle(option: { id: string }, layout?: { local?: boolean }) {
    return (
      <span data-testid={`branch-${option.id}`}>
        {layout?.local ? "local" : "node"}
      </span>
    );
  }

  function mockCarouselGeometry(params: {
    scrollLeft: number;
    clientWidth: number;
    cards: Array<{ id: string; offsetLeft: number; offsetWidth: number }>;
  }) {
    const viewport = screen.getByTestId(
      "carousel-cards-viewport"
    ) as HTMLDivElement;
    const metrics = { scrollLeft: params.scrollLeft };
    Object.defineProperties(viewport, {
      clientWidth: {
        configurable: true,
        get: () => params.clientWidth,
      },
      scrollLeft: {
        configurable: true,
        get: () => metrics.scrollLeft,
        set: (value: number) => {
          metrics.scrollLeft = value;
        },
      },
    });
    for (const card of params.cards) {
      const node = viewport.querySelector(
        `[data-carousel-card-id="${card.id}"]`
      );
      if (!(node instanceof HTMLElement)) continue;
      Object.defineProperty(node, "offsetLeft", {
        configurable: true,
        value: card.offsetLeft,
      });
      Object.defineProperty(node, "offsetWidth", {
        configurable: true,
        value: card.offsetWidth,
      });
    }
    return { viewport, metrics };
  }

  it("puts visible-card dots on each CTA and hides unlinked peeked cards", () => {
    const renderBranchHandle = jest.fn(renderHandle);
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two")]}
        createOptionId={() => "option"}
        renderBranchHandle={renderBranchHandle}
        onChange={jest.fn()}
      />
    );

    const visibleHandle = screen.getByTestId("branch-one-option");
    expect(visibleHandle.textContent).toBe("local");
    expect(visibleHandle.closest(".group\\/option")).not.toBeNull();
    expect(
      visibleHandle.closest(".service-message-carousel-card")
    ).not.toBeNull();
    expect(screen.queryByTestId("branch-two-option")).toBeNull();
    expect(screen.queryByTestId("carousel-option-handle-rail")).toBeNull();
    expect(renderBranchHandle).toHaveBeenCalledWith(
      expect.objectContaining({ id: "one-option" }),
      { local: true }
    );
    expect(renderBranchHandle).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "two-option" }),
      expect.anything()
    );
  });

  it("pins a hidden connected card to the node-right rail", () => {
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two")]}
        createOptionId={() => "option"}
        connectedOptionIds={new Set(["two-option"])}
        renderBranchHandle={renderHandle}
        onChange={jest.fn()}
      />
    );

    const visibleHandle = screen.getByTestId("branch-one-option");
    const hiddenHandle = screen.getByTestId("branch-two-option");
    const rail = screen.getByTestId("carousel-option-handle-rail");
    expect(visibleHandle.closest(".group\\/option")).not.toBeNull();
    expect(rail.contains(hiddenHandle)).toBe(true);
    expect(hiddenHandle.closest(".service-message-carousel-card")).toBeNull();
    expect(screen.queryByTestId("carousel-hidden-connection-badge")).toBeNull();
  });

  it("badges stacked hidden connections that share a CTA row", () => {
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two"), card("three")]}
        createOptionId={() => "option"}
        connectedOptionIds={new Set(["two-option", "three-option"])}
        renderBranchHandle={renderHandle}
        onChange={jest.fn()}
      />
    );

    const badge = screen.getByTestId("carousel-hidden-connection-badge");
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveAttribute("role", "img");
    expect(badge).toHaveAccessibleName(
      "whatsappServiceCarouselHiddenConnectionCount 2"
    );
    expect(screen.getByTestId("carousel-option-handle-rail")).toContainElement(
      screen.getByTestId("branch-two-option")
    );
    expect(screen.getByTestId("carousel-option-handle-rail")).toContainElement(
      screen.getByTestId("branch-three-option")
    );
    expect(
      screen.getByTestId("branch-one-option").closest(".group\\/option")
    ).not.toBeNull();
  });

  it("moves dots from the rail onto the newly visible card while scrolling", () => {
    render(
      <ServiceMessageCarouselFields
        cards={[card("one"), card("two")]}
        createOptionId={() => "option"}
        connectedOptionIds={new Set(["one-option", "two-option"])}
        renderBranchHandle={renderHandle}
        onChange={jest.fn()}
      />
    );

    const { viewport, metrics } = mockCarouselGeometry({
      scrollLeft: 0,
      clientWidth: 200,
      cards: [
        { id: "one", offsetLeft: 0, offsetWidth: 160 },
        { id: "two", offsetLeft: 168, offsetWidth: 160 },
      ],
    });
    fireEvent.scroll(viewport);

    expect(
      screen.getByTestId("branch-one-option").closest(".group\\/option")
    ).not.toBeNull();
    expect(screen.getByTestId("carousel-option-handle-rail")).toContainElement(
      screen.getByTestId("branch-two-option")
    );

    metrics.scrollLeft = 180;
    fireEvent.scroll(viewport);

    expect(
      screen.getByTestId("branch-two-option").closest(".group\\/option")
    ).not.toBeNull();
    expect(screen.getByTestId("carousel-option-handle-rail")).toContainElement(
      screen.getByTestId("branch-one-option")
    );
    expect(
      screen
        .getByTestId("branch-one-option")
        .closest(".service-message-carousel-card")
    ).toBeNull();
  });

  it("puts a visible-card dot on every CTA row", () => {
    const cards = [card("one"), card("two")].map(current => ({
      ...current,
      interaction: {
        kind: "quick_replies" as const,
        options: [
          { id: `${current.id}-one`, label: "First" },
          { id: `${current.id}-two`, label: "Second" },
        ],
      },
    }));
    render(
      <ServiceMessageCarouselFields
        cards={cards}
        createOptionId={() => "option"}
        renderBranchHandle={renderHandle}
        onChange={jest.fn()}
      />
    );

    expect(
      screen.getByTestId("branch-one-one").closest(".group\\/option")
    ).not.toBeNull();
    expect(
      screen.getByTestId("branch-one-two").closest(".group\\/option")
    ).not.toBeNull();
    expect(screen.queryByTestId("branch-two-one")).toBeNull();
    expect(screen.queryByTestId("branch-two-two")).toBeNull();
  });

  it("keeps a node-edge slot per hidden CTA row", () => {
    const cards = [card("one"), card("two")].map(current => ({
      ...current,
      interaction: {
        kind: "quick_replies" as const,
        options: [
          { id: `${current.id}-one`, label: "First" },
          { id: `${current.id}-two`, label: "Second" },
        ],
      },
    }));
    render(
      <ServiceMessageCarouselFields
        cards={cards}
        createOptionId={() => "option"}
        connectedOptionIds={new Set(["two-one", "two-two"])}
        renderBranchHandle={renderHandle}
        onChange={jest.fn()}
      />
    );

    const rail = screen.getByTestId("carousel-option-handle-rail");
    const clusters = screen.getAllByTestId(
      "carousel-hidden-connection-cluster"
    );
    expect(clusters).toHaveLength(2);
    expect(rail).toContainElement(screen.getByTestId("branch-two-one"));
    expect(rail).toContainElement(screen.getByTestId("branch-two-two"));
    expect(screen.queryByTestId("carousel-hidden-connection-badge")).toBeNull();
    expect(
      screen.getByTestId("branch-one-one").closest(".group\\/option")
    ).not.toBeNull();
    expect(
      screen.getByTestId("branch-one-two").closest(".group\\/option")
    ).not.toBeNull();
  });
});
