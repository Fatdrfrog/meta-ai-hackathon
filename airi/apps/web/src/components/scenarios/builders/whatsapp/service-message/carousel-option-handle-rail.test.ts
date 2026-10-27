/**
 * @jest-environment jsdom
 */

import {
  clusterHiddenConnectedHandles,
  readCarouselOptionHandleRail,
  type CarouselOptionHandleLayout,
} from "./carousel-option-handle-rail";

function pxRect(
  left: number,
  top: number,
  width: number,
  height: number
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return this;
    },
  };
}

function mountTwoCardCarousel(params: {
  scrollLeft: number;
  rowATop: number;
  rowBTop: number;
}) {
  const wrap = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.setAttribute("data-testid", "carousel-cards-viewport");
  const cardA = document.createElement("div");
  cardA.className = "service-message-carousel-card";
  cardA.dataset.carouselCardId = "a";
  const rowA = document.createElement("div");
  rowA.dataset.carouselOptionId = "opt-a";
  rowA.dataset.carouselOptionIndex = "0";
  cardA.append(rowA);
  const cardB = document.createElement("div");
  cardB.className = "service-message-carousel-card";
  cardB.dataset.carouselCardId = "b";
  const rowB = document.createElement("div");
  rowB.dataset.carouselOptionId = "opt-b";
  rowB.dataset.carouselOptionIndex = "0";
  cardB.append(rowB);
  viewport.append(cardA, cardB);
  wrap.append(viewport);
  document.body.append(wrap);

  Object.defineProperty(viewport, "scrollLeft", { value: params.scrollLeft });
  Object.defineProperty(viewport, "clientWidth", { value: 200 });
  Object.defineProperty(cardA, "offsetLeft", { value: 0 });
  Object.defineProperty(cardA, "offsetWidth", { value: 160 });
  Object.defineProperty(cardB, "offsetLeft", { value: 168 });
  Object.defineProperty(cardB, "offsetWidth", { value: 160 });
  jest
    .spyOn(wrap, "getBoundingClientRect")
    .mockReturnValue(pxRect(0, 0, 200, 300));
  jest
    .spyOn(rowA, "getBoundingClientRect")
    .mockReturnValue(pxRect(8, params.rowATop, 140, 40));
  jest
    .spyOn(rowB, "getBoundingClientRect")
    .mockReturnValue(pxRect(176, params.rowBTop, 140, 40));

  return wrap;
}

describe("readCarouselOptionHandleRail", () => {
  it("marks the card fully in view active and peeked cards hidden on the right", () => {
    const wrap = mountTwoCardCarousel({
      scrollLeft: 0,
      rowATop: 80,
      rowBTop: 80,
    });

    expect(readCarouselOptionHandleRail(wrap)).toEqual({
      activeCardIds: ["a"],
      options: [
        {
          optionId: "opt-a",
          cardId: "a",
          optionIndex: 0,
          top: 100,
          visibility: "active",
        },
        {
          optionId: "opt-b",
          cardId: "b",
          optionIndex: 0,
          top: 100,
          visibility: "hiddenRight",
        },
      ],
    });

    wrap.remove();
  });

  it("marks a left-scrolled card as hiddenLeft", () => {
    const wrap = mountTwoCardCarousel({
      scrollLeft: 180,
      rowATop: 80,
      rowBTop: 80,
    });

    expect(readCarouselOptionHandleRail(wrap)).toEqual({
      activeCardIds: ["b"],
      options: [
        {
          optionId: "opt-a",
          cardId: "a",
          optionIndex: 0,
          top: 100,
          visibility: "hiddenLeft",
        },
        {
          optionId: "opt-b",
          cardId: "b",
          optionIndex: 0,
          top: 100,
          visibility: "active",
        },
      ],
    });

    wrap.remove();
  });

  it("places rows in layout pixels when the canvas is zoomed", () => {
    // At 50% zoom the 400px-wide wrap measures 200px on screen.
    const wrap = mountTwoCardCarousel({
      scrollLeft: 0,
      rowATop: 80,
      rowBTop: 130,
    });
    Object.defineProperty(wrap, "offsetWidth", { value: 400 });

    expect(
      readCarouselOptionHandleRail(wrap).options.map(option => option.top)
    ).toEqual([200, 300]);

    wrap.remove();
  });
});

/** The step's template carousel: 160px cards, 8px gap, 344px viewport. */
function mountTemplateCarousel(params: {
  cardCount: number;
  scrollLeft: number;
  clientWidth?: number;
  /** 0 models cards that aren't laid out yet. */
  cardWidth?: number;
}) {
  const cardWidth = params.cardWidth ?? 160;
  const wrap = document.createElement("div");
  const viewport = document.createElement("div");
  viewport.setAttribute("data-testid", "carousel-cards-viewport");
  for (let index = 0; index < params.cardCount; index += 1) {
    const card = document.createElement("div");
    card.dataset.carouselCardId = String(index);
    const row = document.createElement("div");
    row.dataset.carouselOptionId = `opt-${index}`;
    row.dataset.carouselOptionIndex = "0";
    card.append(row);
    Object.defineProperty(card, "offsetLeft", {
      value: cardWidth > 0 ? index * (cardWidth + 8) : 0,
    });
    Object.defineProperty(card, "offsetWidth", { value: cardWidth });
    viewport.append(card);
  }
  wrap.append(viewport);
  document.body.append(wrap);
  Object.defineProperty(viewport, "scrollLeft", { value: params.scrollLeft });
  Object.defineProperty(viewport, "clientWidth", {
    value: params.clientWidth ?? 344,
  });
  return wrap;
}

function readVisibilities(wrap: HTMLElement) {
  return readCarouselOptionHandleRail(wrap).options.map(
    option => option.visibility
  );
}

describe("readCarouselOptionHandleRail on the step's template carousel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("gives the last card its dots once scrolled to the end", () => {
    const wrap = mountTemplateCarousel({ cardCount: 4, scrollLeft: 320 });

    expect(readCarouselOptionHandleRail(wrap).activeCardIds).toEqual([
      "2",
      "3",
    ]);
    expect(readVisibilities(wrap)).toEqual([
      "hiddenLeft",
      "hiddenLeft",
      "active",
      "active",
    ]);
  });

  it("gives both cards at the start their dots", () => {
    const wrap = mountTemplateCarousel({ cardCount: 4, scrollLeft: 0 });

    expect(readCarouselOptionHandleRail(wrap).activeCardIds).toEqual([
      "0",
      "1",
    ]);
    expect(readVisibilities(wrap)).toEqual([
      "active",
      "active",
      "hiddenRight",
      "hiddenRight",
    ]);
  });

  it("keeps the last card at a fractional scroll end", () => {
    const wrap = mountTemplateCarousel({ cardCount: 4, scrollLeft: 319.5 });

    expect(readCarouselOptionHandleRail(wrap).activeCardIds).toEqual([
      "2",
      "3",
    ]);
  });

  it("leaves a card cut off by a few pixels hidden", () => {
    const wrap = mountTemplateCarousel({ cardCount: 4, scrollLeft: 317 });

    expect(readCarouselOptionHandleRail(wrap).activeCardIds).toEqual(["2"]);
    expect(readVisibilities(wrap)).toEqual([
      "hiddenLeft",
      "hiddenLeft",
      "active",
      "hiddenRight",
    ]);
  });

  it("falls back to the most visible card when no card fits whole", () => {
    const wrap = mountTemplateCarousel({
      cardCount: 4,
      scrollLeft: 90,
      clientWidth: 200,
    });

    expect(readCarouselOptionHandleRail(wrap).activeCardIds).toEqual(["1"]);
  });

  it("starts with the first card before the cards are laid out", () => {
    const wrap = mountTemplateCarousel({
      cardCount: 2,
      scrollLeft: 0,
      clientWidth: 0,
      cardWidth: 0,
    });

    expect(readCarouselOptionHandleRail(wrap).activeCardIds).toEqual(["0"]);
  });

  it("keeps a connected route of a card in view off the rail", () => {
    const wrap = mountTemplateCarousel({ cardCount: 4, scrollLeft: 320 });

    expect(
      clusterHiddenConnectedHandles(
        readCarouselOptionHandleRail(wrap).options,
        new Set(["opt-0", "opt-3"])
      ).flatMap(cluster => cluster.optionIds)
    ).toEqual(["opt-0"]);
  });
});

describe("clusterHiddenConnectedHandles", () => {
  const layouts: CarouselOptionHandleLayout[] = [
    {
      optionId: "visible",
      cardId: "a",
      optionIndex: 0,
      top: 100,
      visibility: "active",
    },
    {
      optionId: "right-one",
      cardId: "b",
      optionIndex: 0,
      top: 100,
      visibility: "hiddenRight",
    },
    {
      optionId: "right-two",
      cardId: "c",
      optionIndex: 0,
      top: 108,
      visibility: "hiddenRight",
    },
    {
      optionId: "right-lower",
      cardId: "b",
      optionIndex: 1,
      top: 148,
      visibility: "hiddenRight",
    },
    {
      optionId: "unlinked-hidden",
      cardId: "c",
      optionIndex: 1,
      top: 148,
      visibility: "hiddenRight",
    },
    {
      optionId: "left-one",
      cardId: "z",
      optionIndex: 0,
      top: 102,
      visibility: "hiddenLeft",
    },
  ];

  it("ignores the visible card and unlinked hidden CTAs", () => {
    expect(
      clusterHiddenConnectedHandles(layouts, new Set(["visible"]))
    ).toEqual([]);
  });

  it("stacks hidden connected CTAs that share a row, including left-scrolled cards", () => {
    expect(
      clusterHiddenConnectedHandles(
        layouts,
        new Set(["right-one", "right-two", "left-one"])
      )
    ).toEqual([
      {
        optionIndex: 0,
        top: (100 + 102 + 108) / 3,
        optionIds: ["right-one", "left-one", "right-two"],
      },
    ]);
  });

  it("keeps a separate slot when a hidden CTA sits on another row", () => {
    expect(
      clusterHiddenConnectedHandles(
        layouts,
        new Set(["right-one", "right-lower"])
      )
    ).toEqual([
      { optionIndex: 0, top: 100, optionIds: ["right-one"] },
      { optionIndex: 1, top: 148, optionIds: ["right-lower"] },
    ]);
  });

  it("still stacks the same CTA row when hidden cards have different heights", () => {
    expect(
      clusterHiddenConnectedHandles(
        [
          ...layouts,
          {
            optionId: "tall-one",
            cardId: "d",
            optionIndex: 0,
            top: 188,
            visibility: "hiddenRight",
          },
        ],
        new Set(["right-one", "tall-one"])
      )
    ).toEqual([
      {
        optionIndex: 0,
        top: (100 + 188) / 2,
        optionIds: ["right-one", "tall-one"],
      },
    ]);
  });
});
