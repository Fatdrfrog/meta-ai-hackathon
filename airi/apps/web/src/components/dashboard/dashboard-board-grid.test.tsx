/** @jest-environment jsdom */

import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardBoardGrid } from "./dashboard-board-grid";
import type {
  DashboardBoardCard,
  OutcomesBoardCard,
} from "./dashboard-board-model";

jest.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) =>
      values?.card ? `${key} ${values.card}` : key,
}));

function mount(editing = true) {
  function Grid() {
    const [cards, setCards] = useState<DashboardBoardCard[]>([
      { id: "total", width: 1, height: 1 },
      { id: "volume", width: 3, height: 2 },
    ]);
    return (
      <>
        <output aria-label="layout">{JSON.stringify(cards)}</output>
        <DashboardBoardGrid
          cards={cards}
          editing={editing}
          onCardsChange={setCards}
          renderCard={id => <div>{id} content</div>}
        />
      </>
    );
  }
  return render(<Grid />);
}

describe("DashboardBoardGrid", () => {
  it("reuses the sortable grid for Outcomes with caller labels, natural content and reduced motion", async () => {
    const user = userEvent.setup();
    function OutcomesGrid() {
      const [cards, setCards] = useState<OutcomesBoardCard[]>([
        { id: "acquisition", width: 4, height: 1 },
        { id: "delivery", width: 2, height: 1 },
      ]);
      return (
        <>
          <output aria-label="outcomes layout">{JSON.stringify(cards)}</output>
          <DashboardBoardGrid
            cards={cards}
            editing
            onCardsChange={setCards}
            gridLabel="Outcomes workspace"
            getCardLabel={id => `Report ${id}`}
            renderCard={id => <div>{id} report content</div>}
          />
        </>
      );
    }
    const { container } = render(<OutcomesGrid />);
    expect(screen.getByLabelText("Outcomes workspace")).not.toBeNull();
    const card = container.querySelector('[data-card-id="acquisition"]')!;
    expect(card.className).toContain("motion-reduce:!transition-none");
    expect(card.className).toContain("xl:col-span-4");
    expect(card.className).not.toMatch(/overflow-|h-\[/);
    screen.getByRole("button", { name: "move: Report acquisition" }).focus();
    await user.keyboard("[Space]");
    expect(
      await screen.findByText("dragStarted Report acquisition")
    ).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(
      await screen.findByText("dragCancelled Report acquisition")
    ).not.toBeNull();
    await user.click(
      screen.getByRole("button", { name: "cardSettings: Report delivery" })
    );
    const settings = await screen.findByRole("dialog", {
      name: "cardSettings: Report delivery",
    });
    await user.click(within(settings).getByRole("button", { name: "earlier" }));
    expect(
      JSON.parse(screen.getByLabelText("outcomes layout").textContent!).map(
        (item: OutcomesBoardCard) => item.id
      )
    ).toEqual(["delivery", "acquisition"]);
    await user.click(within(settings).getByRole("button", { name: "remove" }));
    expect(screen.queryByText("delivery report content")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "cardSettings: Report acquisition" })
      )
    );
  });

  it("uses visible text editing controls without clipping card contents", () => {
    const { container } = mount();
    expect(screen.getAllByText("move")).toHaveLength(2);
    expect(screen.getAllByText("cardSettings")).toHaveLength(2);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label")).toContain(button.textContent);
    }
    expect(container.querySelector(".lucide")).toBeNull();
    const content = screen.getByText("volume content").parentElement!;
    expect(content.className).not.toContain("overflow-auto");
    const card = content.closest("[data-card-id]") as HTMLElement;
    expect(card.style.gridRow).toBe("");
    expect(card.className).toContain("sm:row-span-2");
  });
  it("provides localized keyboard drag instructions", () => {
    mount();
    const handle = screen.getByRole("button", { name: "move: cards.total" });
    const instructions = document.getElementById(
      handle.getAttribute("aria-describedby")!
    );
    expect(instructions?.textContent).toBe("dragInstructions");
  });

  it("announces keyboard dragging using translated card names", async () => {
    const user = userEvent.setup();
    mount();
    screen.getByRole("button", { name: "move: cards.total" }).focus();
    await user.keyboard("[Space]");
    expect(await screen.findByText("dragStarted cards.total")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(await screen.findByText("dragCancelled cards.total")).not.toBeNull();
  });

  it("changes discrete card dimensions without changing another card", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "cardSettings: cards.total" })
    );
    const settings = await screen.findByRole("dialog", {
      name: "cardSettings: cards.total",
    });
    fireEvent.change(
      within(settings).getByRole("combobox", { name: "width" }),
      { target: { value: "4" } }
    );
    fireEvent.change(
      within(settings).getByRole("combobox", { name: "height" }),
      { target: { value: "3" } }
    );
    expect(JSON.parse(screen.getByLabelText("layout").textContent!)).toEqual([
      { id: "total", width: 4, height: 3 },
      { id: "volume", width: 3, height: 2 },
    ]);
  });

  it("allows keyboard users to move a card earlier and remove it", async () => {
    const user = userEvent.setup();
    mount();
    const trigger = screen.getByRole("button", {
      name: "cardSettings: cards.volume",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    const settings = await screen.findByRole("dialog", {
      name: "cardSettings: cards.volume",
    });
    const earlier = within(settings).getByRole("button", { name: "earlier" });
    earlier.focus();
    await user.keyboard("{Enter}");
    expect(
      JSON.parse(screen.getByLabelText("layout").textContent!).map(
        (card: DashboardBoardCard) => card.id
      )
    ).toEqual(["volume", "total"]);
    const remove = within(settings).getByRole("button", { name: "remove" });
    remove.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("volume content")).toBeNull();
    expect(screen.getByText("total content")).not.toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "cardSettings: cards.total" })
      )
    );
  });

  it("shows data without drag or settings controls in reading mode", () => {
    const { container } = mount(false);
    expect(screen.getByText("volume content")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /cardSettings|move/ })
    ).toBeNull();
    expect(container.querySelector("[data-resize-handle]")).toBeNull();
  });
});

describe("DashboardBoardGrid drag-to-resize", () => {
  const originalPointerEvent = window.PointerEvent;
  const originalComputedStyle = window.getComputedStyle.bind(window);
  let columns = "200px 200px 200px 200px";

  beforeAll(() => {
    // jsdom has no PointerEvent; MouseEvent carries the client coordinates.
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent,
    });
  });
  afterAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: originalPointerEvent,
    });
  });
  beforeEach(() => {
    columns = "200px 200px 200px 200px";
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element: Element) =>
        element.getAttribute("aria-label") === "grid"
          ? ({
              gridTemplateColumns: columns,
              columnGap: "12px",
              rowGap: "12px",
            } as CSSStyleDeclaration)
          : originalComputedStyle(element)
      );
    jest
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ height: 145 } as DOMRect);
  });
  afterEach(() => jest.restoreAllMocks());

  function handleFor(container: HTMLElement, id: string) {
    const card = container.querySelector<HTMLElement>(
      `[data-card-id="${id}"]`
    )!;
    return {
      card,
      handle: card.querySelector<HTMLElement>("[data-resize-handle]")!,
    };
  }

  it("previews the snapped size while dragging and saves it on release", () => {
    const { container } = mount();
    const { card, handle } = handleFor(container, "total");
    expect(handle.getAttribute("aria-hidden")).toBe("true");
    expect(handle.className).toContain("hidden");
    expect(handle.className).toContain("sm:flex");
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 215, clientY: 185 });
    expect(card.className).toContain("xl:col-span-2");
    expect(card.className).toContain("sm:row-span-2");
    expect(screen.getByText("resizePreview")).toBeTruthy();
    expect(JSON.parse(screen.getByLabelText("layout").textContent!)[0]).toEqual(
      { id: "total", width: 1, height: 1 }
    );
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 215, clientY: 185 });
    expect(JSON.parse(screen.getByLabelText("layout").textContent!)).toEqual([
      { id: "total", width: 2, height: 2 },
      { id: "volume", width: 3, height: 2 },
    ]);
    expect(screen.queryByText("resizePreview")).toBeNull();
  });

  it("cancels a resize with Escape or a cancelled pointer", () => {
    const { container } = mount();
    const { card, handle } = handleFor(container, "total");
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450, clientY: 0 });
    expect(card.className).toContain("xl:col-span-3");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(card.className).toContain("xl:col-span-1");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 450, clientY: 0 });
    fireEvent.pointerDown(handle, {
      pointerId: 2,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 450, clientY: 0 });
    fireEvent.pointerCancel(handle, { pointerId: 2, clientX: 450, clientY: 0 });
    expect(card.className).toContain("xl:col-span-1");
    expect(JSON.parse(screen.getByLabelText("layout").textContent!)[0]).toEqual(
      { id: "total", width: 1, height: 1 }
    );
  });

  it("does not resize on a single-column layout", () => {
    columns = "600px";
    const { container } = mount();
    const { card, handle } = handleFor(container, "volume");
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(handle, {
      pointerId: 1,
      clientX: -500,
      clientY: 300,
    });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: -500, clientY: 300 });
    expect(card.className).toContain("xl:col-span-3");
    expect(JSON.parse(screen.getByLabelText("layout").textContent!)[1]).toEqual(
      { id: "volume", width: 3, height: 2 }
    );
  });
});
