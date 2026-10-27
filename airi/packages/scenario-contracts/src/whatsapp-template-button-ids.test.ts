import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWhatsAppTemplateButtonPayload,
  buildWhatsAppTemplateButtonSourceHandleId,
  createWhatsAppTemplateQuickReplyPayloadFactory,
  listWhatsAppTemplateQuickReplyButtons,
  normalizeScenarioWhatsAppTemplateButtonIds,
  normalizeWhatsAppTemplateButtonText,
  parseWhatsAppTemplateButtonPayload,
  parseWhatsAppTemplateButtonSourceHandleId,
  reconcileSentWhatsAppTemplateButtons,
  rekeyStoredWhatsAppTemplateButtonIds,
  rekeyWhatsAppTemplateButtonIds,
  resolveWhatsAppInteractiveReplyTriggerEventKind,
  resolveWhatsAppTemplateButtons,
  SCENARIO_TRIGGER_EVENT_KIND,
  type ScenarioWhatsAppTemplateButtonIds,
} from "./index.ts";

type TestButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string };

function quickReply(text: string): TestButton {
  return { type: "QUICK_REPLY", text };
}

function urlButton(text: string): TestButton {
  return { type: "URL", text, url: "https://shop.test/plans" };
}

function template(buttons: TestButton[]) {
  return [
    { type: "BODY", text: "Which plan do you want?" },
    { type: "BUTTONS", buttons },
  ];
}

const BASIC_PREMIUM = template([quickReply("Basic"), quickReply("Premium")]);
const PREMIUM_ONLY = template([quickReply("Premium")]);

/** The map the inline editor saves after Basic is deleted from Basic, Premium. */
function premiumAfterBasicDeleted(): ScenarioWhatsAppTemplateButtonIds {
  const map = rekeyWhatsAppTemplateButtonIds({
    previous: { components: BASIC_PREMIUM, buttonIds: undefined },
    components: PREMIUM_ONLY,
    match: { origins: [1] },
  });
  assert.ok(map);
  return map;
}

function ids(buttons: Array<{ id: number | null }>) {
  return buttons.map((button) => button.id);
}

describe("template button id normalization", () => {
  it("treats a missing map as absent", () => {
    for (const value of [undefined, null]) {
      assert.deepEqual(normalizeScenarioWhatsAppTemplateButtonIds(value), {
        status: "absent",
        value: null,
      });
    }
  });

  it("trims labels and keeps nextId above every id and every position", () => {
    assert.deepEqual(
      normalizeScenarioWhatsAppTemplateButtonIds({
        version: 1,
        nextId: 3,
        buttons: [
          { id: 1, index: 0, text: " Premium " },
          { id: 12, index: 1, text: "Gold" },
        ],
        ignored: true,
      }),
      {
        status: "supported",
        value: {
          version: 1,
          nextId: 13,
          buttons: [
            { id: 1, index: 0, text: "Premium" },
            { id: 12, index: 1, text: "Gold" },
          ],
        },
      },
    );
    assert.equal(
      normalizeScenarioWhatsAppTemplateButtonIds({
        version: 1,
        nextId: 0,
        buttons: [],
      }).value?.nextId,
      10,
    );
  });

  it("rejects the whole map when any part is malformed", () => {
    const valid = { id: 1, index: 0, text: "Premium" };
    for (const value of [
      "map",
      [valid],
      { nextId: 10, buttons: [valid] },
      { version: 3, nextId: 10, buttons: [valid] },
      { version: 1, nextId: 10, buttons: [{ ...valid, cardIndex: 0 }] },
      { version: 2, nextId: 10, buttons: [{ ...valid, cardIndex: -1 }] },
      { version: 2, nextId: 10, buttons: [{ ...valid, cardIndex: "0" }] },
      {
        version: 2,
        nextId: 12,
        buttons: [
          { ...valid, cardIndex: 1 },
          { id: 11, index: 0, text: "Gold", cardIndex: 1 },
        ],
      },
      { version: 1, buttons: [valid] },
      { version: 1, nextId: -1, buttons: [valid] },
      { version: 1, nextId: 10.5, buttons: [valid] },
      { version: 1, nextId: 10 },
      { version: 1, nextId: 10, buttons: [valid, null] },
      { version: 1, nextId: 10, buttons: [{ ...valid, id: "1" }] },
      { version: 1, nextId: 10, buttons: [{ ...valid, id: -1 }] },
      { version: 1, nextId: 10, buttons: [{ ...valid, index: 0.5 }] },
      { version: 1, nextId: 10, buttons: [{ ...valid, text: "  " }] },
      {
        version: 1,
        nextId: 10,
        buttons: [valid, { id: 1, index: 1, text: "Gold" }],
      },
      {
        version: 1,
        nextId: 10,
        buttons: [valid, { id: 2, index: 0, text: "Gold" }],
      },
    ]) {
      const normalized = normalizeScenarioWhatsAppTemplateButtonIds(value);
      assert.equal(normalized.status, "unsupported", JSON.stringify(value));
      assert.equal(
        normalized.status === "unsupported" && normalized.raw,
        value,
      );
    }
  });

  it("compares labels ignoring case and spacing", () => {
    assert.equal(
      normalizeWhatsAppTemplateButtonText("  Премиум   План "),
      "премиум план",
    );
  });
});

describe("resolving a step's template buttons", () => {
  it("uses positions without a map, counting link buttons", () => {
    const components = template([
      urlButton("See plans"),
      quickReply("Basic"),
      quickReply("Premium"),
    ]);

    assert.deepEqual(resolveWhatsAppTemplateButtons(components, undefined), [
      { index: 1, label: "Basic", id: 1 },
      { index: 2, label: "Premium", id: 2 },
    ]);
  });

  it("keeps Premium's id after Basic is deleted", () => {
    const map = premiumAfterBasicDeleted();

    assert.deepEqual(map, {
      version: 1,
      nextId: 10,
      buttons: [{ id: 1, index: 0, text: "Premium" }],
    });
    assert.deepEqual(resolveWhatsAppTemplateButtons(PREMIUM_ONLY, map), [
      { index: 0, label: "Premium", id: 1 },
    ]);
  });

  it("gives every button no id when the map is unsupported", () => {
    for (const buttonIds of [
      { version: 2, nextId: 10, buttons: [] },
      { version: 1, nextId: 10, buttons: [{ id: 0, index: 0 }] },
      "0,1",
    ]) {
      assert.deepEqual(
        ids(resolveWhatsAppTemplateButtons(BASIC_PREMIUM, buttonIds)),
        [null, null],
      );
    }
  });

  it("matches a stale map by text before position", () => {
    const map = {
      version: 1,
      nextId: 12,
      buttons: [
        { id: 10, index: 0, text: "Basic" },
        { id: 11, index: 1, text: "Premium" },
      ],
    };

    assert.deepEqual(
      resolveWhatsAppTemplateButtons(
        template([quickReply("premium"), quickReply("Gold")]),
        map,
      ),
      [
        { index: 0, label: "premium", id: 11 },
        { index: 1, label: "Gold", id: null },
      ],
    );
  });
});

describe("reconciling the sent template with the step's buttons", () => {
  const step = resolveWhatsAppTemplateButtons(BASIC_PREMIUM, undefined);

  function reconcile(buttons: TestButton[]) {
    return ids(
      reconcileSentWhatsAppTemplateButtons(
        listWhatsAppTemplateQuickReplyButtons(template(buttons)),
        step,
      ),
    );
  }

  it("follows the text when the live template is reordered", () => {
    assert.deepEqual(
      reconcile([quickReply("Premium"), quickReply("Basic")]),
      [1, 0],
    );
  });

  it("falls back to the position for a translated variant", () => {
    assert.deepEqual(
      reconcile([quickReply("Базовый"), quickReply("Премиум")]),
      [0, 1],
    );
  });

  it("pairs the same index and text before a unique text", () => {
    const duplicated = resolveWhatsAppTemplateButtons(
      template([quickReply("Yes"), quickReply("No"), quickReply("Yes")]),
      undefined,
    );

    assert.deepEqual(
      ids(
        reconcileSentWhatsAppTemplateButtons(
          listWhatsAppTemplateQuickReplyButtons(
            template([quickReply("Yes"), quickReply("Yes"), quickReply("No")]),
          ),
          duplicated,
        ),
      ),
      [0, null, 1],
    );
  });

  it("never matches duplicate labels by text", () => {
    const duplicated = resolveWhatsAppTemplateButtons(
      template([quickReply("Yes"), quickReply("Yes")]),
      undefined,
    );

    assert.deepEqual(
      ids(
        reconcileSentWhatsAppTemplateButtons(
          listWhatsAppTemplateQuickReplyButtons(
            template([
              quickReply("No"),
              quickReply("Maybe"),
              quickReply("Yes"),
            ]),
          ),
          duplicated,
        ),
      ),
      [0, 1, null],
    );
  });

  it("leaves a button with no step counterpart without an id", () => {
    assert.deepEqual(
      reconcile([
        quickReply("Premium"),
        quickReply("Basic"),
        quickReply("Gold"),
      ]),
      [1, 0, null],
    );
  });
});

describe("rekeying a step's template buttons", () => {
  it("writes the identity map on the first edit, so routes are unchanged", () => {
    const map = rekeyWhatsAppTemplateButtonIds({
      previous: { components: BASIC_PREMIUM, buttonIds: undefined },
      components: BASIC_PREMIUM,
      match: "byIndex",
    });

    assert.deepEqual(map, {
      version: 1,
      nextId: 10,
      buttons: [
        { id: 0, index: 0, text: "Basic" },
        { id: 1, index: 1, text: "Premium" },
      ],
    });
    assert.deepEqual(
      resolveWhatsAppTemplateButtons(BASIC_PREMIUM, map),
      resolveWhatsAppTemplateButtons(BASIC_PREMIUM, undefined),
    );
  });

  it("mints ids from 10 that are unique and never reused after a delete", () => {
    const premium = premiumAfterBasicDeleted();
    const withGold = rekeyWhatsAppTemplateButtonIds({
      previous: { components: PREMIUM_ONLY, buttonIds: premium },
      components: template([quickReply("Premium"), quickReply("Gold")]),
      match: { origins: [1, null] },
    });
    assert.deepEqual(withGold, {
      version: 1,
      nextId: 11,
      buttons: [
        { id: 1, index: 0, text: "Premium" },
        { id: 10, index: 1, text: "Gold" },
      ],
    });

    const goldDeleted = rekeyWhatsAppTemplateButtonIds({
      previous: {
        components: template([quickReply("Premium"), quickReply("Gold")]),
        buttonIds: withGold,
      },
      components: PREMIUM_ONLY,
      match: { origins: [1] },
    });
    const withSilver = rekeyWhatsAppTemplateButtonIds({
      previous: { components: PREMIUM_ONLY, buttonIds: goldDeleted },
      components: template([
        quickReply("Premium"),
        quickReply("Silver"),
        quickReply("Bronze"),
      ]),
      match: { origins: [1, null, null] },
    });
    assert.deepEqual(goldDeleted?.nextId, 11);
    assert.deepEqual(ids(withSilver?.buttons ?? []), [1, 11, 12]);
    assert.equal(withSilver?.nextId, 13);
  });

  it("mints an id for an unknown or repeated origin", () => {
    const map = rekeyWhatsAppTemplateButtonIds({
      previous: { components: BASIC_PREMIUM, buttonIds: undefined },
      components: template([
        quickReply("Basic"),
        quickReply("Premium"),
        quickReply("Gold"),
      ]),
      match: { origins: [0, 0, 7] },
    });

    assert.deepEqual(ids(map?.buttons ?? []), [0, 10, 11]);
  });

  it("keeps ids only on same-text buttons when another template is picked", () => {
    const map = rekeyWhatsAppTemplateButtonIds({
      previous: { components: BASIC_PREMIUM, buttonIds: undefined },
      components: template([
        quickReply("Gold"),
        quickReply("premium"),
        quickReply("Silver"),
      ]),
      match: "textOnly",
    });

    assert.deepEqual(map?.buttons, [
      { id: 10, index: 0, text: "Gold" },
      { id: 1, index: 1, text: "premium" },
      { id: 11, index: 2, text: "Silver" },
    ]);
  });

  it("carries ids by position for a rewritten template", () => {
    const map = rekeyWhatsAppTemplateButtonIds({
      previous: { components: BASIC_PREMIUM, buttonIds: undefined },
      components: template([quickReply("Starter"), quickReply("Premium")]),
      match: "byIndex",
    });

    assert.deepEqual(ids(map?.buttons ?? []), [0, 1]);
  });

  it("keeps nextId when a template loses all its quick replies", () => {
    const empty = rekeyWhatsAppTemplateButtonIds({
      previous: {
        components: template([quickReply("Premium"), quickReply("Gold")]),
        buttonIds: {
          version: 1,
          nextId: 11,
          buttons: [
            { id: 1, index: 0, text: "Premium" },
            { id: 10, index: 1, text: "Gold" },
          ],
        },
      },
      components: template([urlButton("See plans")]),
      match: { origins: [] },
    });

    assert.deepEqual(empty, { version: 1, nextId: 11, buttons: [] });
  });

  it("leaves an unsupported map for its writer to read", () => {
    assert.equal(
      rekeyWhatsAppTemplateButtonIds({
        previous: {
          components: BASIC_PREMIUM,
          buttonIds: { version: 3, nextId: 30, buttons: [] },
        },
        components: BASIC_PREMIUM,
        match: "byIndex",
      }),
      null,
    );
  });
});

describe("storing a step's template button ids", () => {
  it("stores no map while every button keeps its position", () => {
    for (const components of [
      BASIC_PREMIUM,
      template([quickReply("Starter"), quickReply("Premium")]),
      template([quickReply("Basic"), quickReply("Premium"), urlButton("See")]),
    ]) {
      assert.equal(
        rekeyStoredWhatsAppTemplateButtonIds({
          previous: { components: BASIC_PREMIUM, buttonIds: undefined },
          components,
          match: "byIndex",
        }),
        undefined,
      );
    }
  });

  it("stores no map for a step that had no quick replies", () => {
    assert.equal(
      rekeyStoredWhatsAppTemplateButtonIds({
        previous: {
          components: template([urlButton("See plans")]),
          buttonIds: undefined,
        },
        components: BASIC_PREMIUM,
        match: "textOnly",
      }),
      undefined,
    );
  });

  it("stores the map once a button moves or its id goes away", () => {
    assert.deepEqual(
      rekeyStoredWhatsAppTemplateButtonIds({
        previous: { components: BASIC_PREMIUM, buttonIds: undefined },
        components: PREMIUM_ONLY,
        match: { origins: [1] },
      }),
      premiumAfterBasicDeleted(),
    );
    assert.deepEqual(
      rekeyStoredWhatsAppTemplateButtonIds({
        previous: { components: BASIC_PREMIUM, buttonIds: undefined },
        components: template([quickReply("Basic")]),
        match: { origins: [0] },
      }),
      { version: 1, nextId: 10, buttons: [{ id: 0, index: 0, text: "Basic" }] },
    );
  });

  it("keeps rewriting a stored map and leaves an unsupported one alone", () => {
    const premium = premiumAfterBasicDeleted();
    assert.deepEqual(
      rekeyStoredWhatsAppTemplateButtonIds({
        previous: { components: PREMIUM_ONLY, buttonIds: premium },
        components: PREMIUM_ONLY,
        match: "byIndex",
      }),
      premium,
    );
    assert.equal(
      rekeyStoredWhatsAppTemplateButtonIds({
        previous: { components: BASIC_PREMIUM, buttonIds: { version: 3 } },
        components: PREMIUM_ONLY,
        match: "byIndex",
      }),
      undefined,
    );
  });
});

describe("template quick-reply payloads", () => {
  /** The payload of each quick reply the send path would build, in order. */
  function payloads(
    buttons: TestButton[],
    step: { components?: unknown; buttonIds?: unknown } = {},
  ) {
    const payload = createWhatsAppTemplateQuickReplyPayloadFactory({
      actionNodeId: "menu",
      sentComponents: template(buttons),
      stepComponents: step.components,
      stepButtonIds: step.buttonIds,
    });
    return buttons.flatMap((button, index) =>
      button.type === "QUICK_REPLY" ? [payload({ index })] : [],
    );
  }

  const premiumStep = () => ({
    components: PREMIUM_ONLY,
    buttonIds: premiumAfterBasicDeleted(),
  });

  it("is byte-identical to the positional payload for an unedited step", () => {
    const buttons = [
      urlButton("See plans"),
      quickReply("Basic"),
      quickReply(" "),
      quickReply("Premium"),
    ];

    assert.deepEqual(payloads(buttons, { components: template(buttons) }), [
      "stb:menu:1",
      "stb:menu:2",
      "stb:menu:3",
    ]);
    assert.deepEqual(
      payloads(buttons, { components: template(buttons) }),
      [1, 2, 3].map((index) =>
        buildWhatsAppTemplateButtonPayload("menu", index),
      ),
    );
  });

  it("uses sent positions when the step has no saved buttons and no map", () => {
    assert.deepEqual(payloads([quickReply("Basic"), quickReply("Premium")]), [
      "stb:menu:0",
      "stb:menu:1",
    ]);
  });

  it("follows the text when the live template is reordered", () => {
    assert.deepEqual(
      payloads([quickReply("Premium"), quickReply("Basic")], {
        components: BASIC_PREMIUM,
      }),
      ["stb:menu:1", "stb:menu:0"],
    );
  });

  it("follows the position when a live button is renamed", () => {
    assert.deepEqual(
      payloads([quickReply("Starter"), quickReply("Premium")], {
        components: BASIC_PREMIUM,
      }),
      ["stb:menu:0", "stb:menu:1"],
    );
  });

  it("sends the id a button kept after an edit", () => {
    assert.deepEqual(payloads([quickReply("Premium")], premiumStep()), [
      "stb:menu:1",
    ]);
  });

  it("sends no payload for a button the step has no id for", () => {
    assert.deepEqual(
      payloads([quickReply("Premium"), quickReply("Gold")], premiumStep()),
      ["stb:menu:1", null],
    );
    assert.deepEqual(
      payloads([quickReply("Basic"), quickReply("Premium")], {
        components: BASIC_PREMIUM,
        buttonIds: { version: 2 },
      }),
      [null, null],
    );
  });

  it("never gives a position another button owns without a map", () => {
    assert.deepEqual(
      payloads([quickReply("Premium"), quickReply("Gold")], {
        components: BASIC_PREMIUM,
      }),
      ["stb:menu:1", null],
    );
    assert.deepEqual(
      payloads(
        [quickReply("Premium"), quickReply("Basic"), quickReply("Gold")],
        { components: BASIC_PREMIUM },
      ),
      ["stb:menu:1", "stb:menu:0", "stb:menu:2"],
    );
  });

  it("never gives a card button the card-local position", () => {
    const payload = createWhatsAppTemplateQuickReplyPayloadFactory({
      actionNodeId: "menu",
      sentComponents: PREMIUM_ONLY,
      stepComponents: PREMIUM_ONLY,
      stepButtonIds: premiumAfterBasicDeleted(),
    });

    assert.equal(payload({ index: 0, cardIndex: 2 }), null);
    assert.equal(payload({ index: 0 }), "stb:menu:1");
  });

  it("sends no payload without an action", () => {
    for (const actionNodeId of [null, undefined, ""]) {
      const payload = createWhatsAppTemplateQuickReplyPayloadFactory({
        actionNodeId,
        sentComponents: BASIC_PREMIUM,
      });
      assert.equal(payload({ index: 0 }), null);
    }
  });
});

describe("carousel card buttons", () => {
  type TestCard = { text: string; buttons: TestButton[] };

  function card(text: string): TestCard {
    return { text, buttons: [quickReply("Interested"), urlButton("Buy")] };
  }

  function carousel(cards: TestCard[], messageButtons?: TestButton[]) {
    return [
      { type: "BODY", text: "Fall 2026 is here" },
      {
        type: "CAROUSEL",
        cards: cards.map((item) => ({
          components: [
            { type: "HEADER", format: "IMAGE" },
            { type: "BODY", text: item.text },
            { type: "BUTTONS", buttons: item.buttons },
          ],
        })),
      },
      ...(messageButtons ? [{ type: "BUTTONS", buttons: messageButtons }] : []),
    ];
  }

  const COLLECTION = carousel([card("Blazer"), card("Coat"), card("Scarf")]);
  const WITHOUT_COAT = carousel([card("Blazer"), card("Scarf")]);

  function cardButton(cardIndex: number, cardText: string, id: number | null) {
    return { index: 0, label: "Interested", cardIndex, cardText, id };
  }

  function payloads(
    sentComponents: unknown,
    step: { components: unknown; buttonIds?: unknown },
  ) {
    const payload = createWhatsAppTemplateQuickReplyPayloadFactory({
      actionNodeId: "menu",
      sentComponents,
      stepComponents: step.components,
      stepButtonIds: step.buttonIds,
    });
    return listWhatsAppTemplateQuickReplyButtons(sentComponents).map((button) =>
      payload(button),
    );
  }

  it("lists each card's quick replies after the message's own", () => {
    assert.deepEqual(
      listWhatsAppTemplateQuickReplyButtons(
        carousel([card("Blazer"), card("Coat")], [quickReply("Call me")]),
      ),
      [
        { index: 0, label: "Call me" },
        { index: 0, label: "Interested", cardIndex: 0, cardText: "Blazer" },
        { index: 0, label: "Interested", cardIndex: 1, cardText: "Coat" },
      ],
    );
  });

  it("gives card buttons ids above every position without a map", () => {
    assert.deepEqual(resolveWhatsAppTemplateButtons(COLLECTION, undefined), [
      cardButton(0, "Blazer", 100),
      cardButton(1, "Coat", 110),
      cardButton(2, "Scarf", 120),
    ]);
  });

  it("reads a version 2 map whose cards share button indexes", () => {
    const map = {
      version: 2,
      nextId: 3,
      buttons: [
        { id: 10, index: 0, text: "Interested", cardIndex: 0 },
        { id: 11, index: 0, text: "Interested", cardIndex: 1 },
      ],
    };
    assert.deepEqual(normalizeScenarioWhatsAppTemplateButtonIds(map), {
      status: "supported",
      value: { ...map, nextId: 12 },
    });
    assert.deepEqual(
      ids(
        resolveWhatsAppTemplateButtons(
          carousel([card("Blazer"), card("Coat")]),
          map,
        ),
      ),
      [10, 11],
    );
  });

  it("stores no map while every card keeps its position", () => {
    for (const match of ["byIndex", "textOnly", { origins: [] }] as const) {
      assert.equal(
        rekeyStoredWhatsAppTemplateButtonIds({
          previous: { components: COLLECTION, buttonIds: undefined },
          components: COLLECTION,
          match,
        }),
        undefined,
      );
    }
  });

  it("keeps a card's ids when another card is removed", () => {
    const map = rekeyStoredWhatsAppTemplateButtonIds({
      previous: { components: COLLECTION, buttonIds: undefined },
      components: WITHOUT_COAT,
      match: "byIndex",
    });

    assert.deepEqual(map, {
      version: 2,
      nextId: 121,
      buttons: [
        { id: 100, index: 0, text: "Interested", cardIndex: 0 },
        { id: 120, index: 0, text: "Interested", cardIndex: 1 },
      ],
    });
    assert.deepEqual(resolveWhatsAppTemplateButtons(WITHOUT_COAT, map), [
      cardButton(0, "Blazer", 100),
      cardButton(1, "Scarf", 120),
    ]);
  });

  it("falls back to card positions when card texts repeat", () => {
    const repeated = carousel([card("New"), card("New"), card("New")]);
    assert.deepEqual(
      ids(
        rekeyWhatsAppTemplateButtonIds({
          previous: { components: repeated, buttonIds: undefined },
          components: carousel([card("New"), card("New")]),
          match: "byIndex",
        })?.buttons ?? [],
      ),
      [100, 110],
    );
  });

  it("keeps card ids through an inline save of the message", () => {
    const map = rekeyWhatsAppTemplateButtonIds({
      previous: { components: COLLECTION, buttonIds: undefined },
      components: WITHOUT_COAT,
      match: "byIndex",
    });
    assert.ok(map);
    assert.deepEqual(
      rekeyStoredWhatsAppTemplateButtonIds({
        previous: { components: WITHOUT_COAT, buttonIds: map },
        components: WITHOUT_COAT,
        match: { origins: [] },
      }),
      map,
    );
  });

  it("writes version 1 again once no card button remains", () => {
    const map = rekeyWhatsAppTemplateButtonIds({
      previous: { components: COLLECTION, buttonIds: undefined },
      components: WITHOUT_COAT,
      match: "byIndex",
    });
    const next = rekeyWhatsAppTemplateButtonIds({
      previous: { components: WITHOUT_COAT, buttonIds: map },
      components: BASIC_PREMIUM,
      match: "textOnly",
    });

    assert.equal(next?.version, 1);
    assert.deepEqual(ids(next?.buttons ?? []), [121, 122]);
  });

  it("never matches a card button with a message button", () => {
    const shop = carousel([
      { text: "Basic plan", buttons: [quickReply("Basic")] },
      { text: "Premium plan", buttons: [quickReply("Premium")] },
    ]);

    assert.deepEqual(
      ids(
        reconcileSentWhatsAppTemplateButtons(
          listWhatsAppTemplateQuickReplyButtons(shop),
          resolveWhatsAppTemplateButtons(BASIC_PREMIUM, undefined),
        ),
      ),
      [null, null],
    );
    assert.deepEqual(payloads(shop, { components: BASIC_PREMIUM }), [
      null,
      null,
    ]);
  });

  it("pays each card button its own id and follows a moved card", () => {
    assert.deepEqual(payloads(COLLECTION, { components: COLLECTION }), [
      "stb:menu:100",
      "stb:menu:110",
      "stb:menu:120",
    ]);
    assert.deepEqual(
      payloads(carousel([card("Coat"), card("Blazer"), card("Scarf")]), {
        components: COLLECTION,
      }),
      ["stb:menu:110", "stb:menu:100", "stb:menu:120"],
    );
  });

  it("sends no payload for a card the step does not have", () => {
    assert.deepEqual(
      payloads(carousel([card("Blazer"), card("Coat"), card("Hat")]), {
        components: carousel([card("Blazer"), card("Coat")]),
      }),
      ["stb:menu:100", "stb:menu:110", null],
    );
  });
});

describe("template button wire format", () => {
  it("keeps today's handle and payload strings", () => {
    assert.equal(
      buildWhatsAppTemplateButtonSourceHandleId(1),
      "right-source-whatsapp-template-button-branch::1",
    );
    assert.equal(
      buildWhatsAppTemplateButtonPayload("node:1", 1),
      "stb:node%3A1:1",
    );
  });

  it("reads minted ids with the parsers older workers run", () => {
    assert.deepEqual(parseWhatsAppTemplateButtonPayload("stb:menu:10"), {
      actionNodeId: "menu",
      buttonId: 10,
    });
    assert.deepEqual(
      parseWhatsAppTemplateButtonSourceHandleId(
        buildWhatsAppTemplateButtonSourceHandleId(10),
      ),
      { buttonId: 10 },
    );
    assert.equal(
      resolveWhatsAppInteractiveReplyTriggerEventKind({
        isWhatsAppFlowReply: false,
        messageType: "button",
        quickReplyPayload: buildWhatsAppTemplateButtonPayload("menu", 10),
      }),
      SCENARIO_TRIGGER_EVENT_KIND.whatsAppButtonReply,
    );
  });

  it("keeps the lenient legacy parse", () => {
    assert.deepEqual(parseWhatsAppTemplateButtonPayload("stb:menu:01"), {
      actionNodeId: "menu",
      buttonId: 1,
    });
    assert.deepEqual(parseWhatsAppTemplateButtonPayload("stb:menu:1abc"), {
      actionNodeId: "menu",
      buttonId: 1,
    });
    assert.deepEqual(
      parseWhatsAppTemplateButtonSourceHandleId(
        "right-source-whatsapp-template-button-branch::01",
      ),
      { buttonId: 1 },
    );
    assert.equal(parseWhatsAppTemplateButtonPayload("stb:menu:-1"), null);
    assert.equal(parseWhatsAppTemplateButtonPayload("stb:menu:b1"), null);
  });
});
