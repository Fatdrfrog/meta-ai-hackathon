import {
  checkTemplateFlowButton,
  collectTemplateFlowButtons,
  collectTemplateFlowIds,
  evaluateTemplateFlowHealth,
  hasTemplateFlowButton,
  isTemplateFlowFacts,
  isWhatsAppFlowGraphId,
  type TemplateFlowButton,
  type TemplateFlowFacts,
} from "./template-flow-health";

const CHECKED_AT = "2026-09-28T12:00:00.000Z";

// Production regression (DemoShop, 2026-09-28): the template opens
// QUESTION_ONE, but the Flow's JSON was overwritten and only has SURVEY_FORM.
const MEDAL_PICK_COMPONENTS = [
  { type: "BODY", text: "Сізге қай спорт түріне арналған дизайн қажет?" },
  { type: "FOOTER", text: "Егер тізімде жоқ болса, жай ғана жазып жіберіңіз" },
  {
    type: "BUTTONS",
    buttons: [
      {
        type: "FLOW",
        text: "Таңдау",
        flow_id: 2244981489363579,
        flow_action: "NAVIGATE",
        navigate_screen: "QUESTION_ONE",
      },
    ],
  },
];

function found(
  overrides: Partial<Extract<TemplateFlowFacts, { state: "found" }>> = {}
): Extract<TemplateFlowFacts, { state: "found" }> {
  return {
    flowId: "2244981489363579",
    state: "found",
    name: "Message templates_medal_pick_1_MARKETING_9b1bc",
    status: "PUBLISHED",
    screenIds: ["SURVEY_FORM"],
    checkedAt: CHECKED_AT,
    ...overrides,
  };
}

function button(
  overrides: Partial<TemplateFlowButton> = {}
): TemplateFlowButton {
  return {
    index: 0,
    text: "Open",
    flowId: "2244981489363579",
    action: "navigate",
    navigateScreen: "QUESTION_ONE",
    ...overrides,
  };
}

describe("collectTemplateFlowButtons", () => {
  it("reads numeric Flow ids and upper-case actions from template snapshots", () => {
    expect(collectTemplateFlowButtons(MEDAL_PICK_COMPONENTS)).toEqual([
      {
        index: 0,
        text: "Таңдау",
        flowId: "2244981489363579",
        action: "navigate",
        navigateScreen: "QUESTION_ONE",
      },
    ]);
  });

  it("keeps each button's position and skips buttons without a Flow id", () => {
    const buttons = collectTemplateFlowButtons([
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Hi" },
          { type: "FLOW", text: "By name", flow_name: "lead_form" },
          {
            type: "FLOW",
            text: "Book",
            flow_id: "123",
            flow_action: "data_exchange",
          },
          { type: "FLOW", text: "No action", flow_id: "456" },
        ],
      },
    ]);

    expect(buttons).toEqual([
      {
        index: 2,
        text: "Book",
        flowId: "123",
        action: "data_exchange",
        navigateScreen: null,
      },
      {
        index: 3,
        text: "No action",
        flowId: "456",
        action: "navigate",
        navigateScreen: null,
      },
    ]);
  });

  it("ignores malformed input", () => {
    expect(collectTemplateFlowButtons(undefined)).toEqual([]);
    expect(collectTemplateFlowButtons({ type: "BUTTONS" })).toEqual([]);
    expect(
      collectTemplateFlowButtons([{ type: "BUTTONS", buttons: "nope" }, null])
    ).toEqual([]);
  });

  it("lists each Flow once", () => {
    expect(
      collectTemplateFlowIds([
        {
          type: "BUTTONS",
          buttons: [
            { type: "FLOW", text: "A", flow_id: "1" },
            { type: "FLOW", text: "B", flow_id: "1" },
            { type: "FLOW", text: "C", flow_id: "2" },
          ],
        },
      ])
    ).toEqual(["1", "2"]);
  });
});

describe("hasTemplateFlowButton", () => {
  it("finds a Flow button however it names its Flow", () => {
    expect(hasTemplateFlowButton(MEDAL_PICK_COMPONENTS)).toBe(true);
    expect(
      hasTemplateFlowButton([
        { type: "buttons", buttons: [{ type: "flow", flow_name: "Order" }] },
      ])
    ).toBe(true);
    expect(
      hasTemplateFlowButton([
        { type: "BODY", text: "Hi" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Yes" }] },
      ])
    ).toBe(false);
    expect(hasTemplateFlowButton(undefined)).toBe(false);
  });
});

describe("checkTemplateFlowButton", () => {
  it("flags a navigate screen that the Flow no longer has", () => {
    expect(checkTemplateFlowButton(button(), found())).toEqual({
      result: "issue",
      button: button(),
      code: "flow_screen_missing",
      flowName: "Message templates_medal_pick_1_MARKETING_9b1bc",
      screenIds: ["SURVEY_FORM"],
    });
  });

  it("passes when the screen exists in a published or throttled Flow", () => {
    const facts = found({ screenIds: ["QUESTION_ONE", "DETAILS"] });
    expect(checkTemplateFlowButton(button(), facts).result).toBe("ok");
    expect(
      checkTemplateFlowButton(button(), { ...facts, status: "THROTTLED" })
        .result
    ).toBe("ok");
  });

  it.each([
    ["DRAFT", "flow_not_published"],
    ["DEPRECATED", "flow_deprecated"],
    ["BLOCKED", "flow_blocked"],
  ])("reports a %s Flow before looking at screens", (status, code) => {
    expect(
      checkTemplateFlowButton(
        button(),
        found({ status, screenIds: ["QUESTION_ONE"] })
      )
    ).toMatchObject({ result: "issue", code });
  });

  it("reports a Flow that is gone", () => {
    expect(
      checkTemplateFlowButton(button(), {
        flowId: "2244981489363579",
        state: "missing",
        checkedAt: CHECKED_AT,
      })
    ).toMatchObject({ result: "issue", code: "flow_missing", flowName: null });
  });

  it("never guesses when Meta or the Flow JSON couldn't be read", () => {
    expect(
      checkTemplateFlowButton(button(), {
        flowId: "2244981489363579",
        state: "unavailable",
        checkedAt: CHECKED_AT,
      }).result
    ).toBe("unverified");
    expect(
      checkTemplateFlowButton(button(), found({ screenIds: null })).result
    ).toBe("unverified");
    expect(
      checkTemplateFlowButton(button(), found({ status: "SOMETHING_NEW" }))
        .result
    ).toBe("unverified");
  });

  it("skips the screen check for data exchange buttons and buttons without a screen", () => {
    expect(
      checkTemplateFlowButton(
        button({ action: "data_exchange", navigateScreen: null }),
        found()
      ).result
    ).toBe("ok");
    expect(
      checkTemplateFlowButton(button({ navigateScreen: null }), found()).result
    ).toBe("ok");
  });

  it("waits for facts that haven't arrived", () => {
    expect(checkTemplateFlowButton(button(), undefined)).toEqual({
      result: "pending",
      button: button(),
    });
  });
});

describe("evaluateTemplateFlowHealth", () => {
  it("flags the medal_pick_1 regression", () => {
    const health = evaluateTemplateFlowHealth(MEDAL_PICK_COMPONENTS, {
      "2244981489363579": found(),
    });

    expect(health.state).toBe("issue");
    expect(health.issues).toHaveLength(1);
    expect(health.issues[0]).toMatchObject({
      code: "flow_screen_missing",
      button: { text: "Таңдау", navigateScreen: "QUESTION_ONE" },
    });
  });

  it("orders states issue > pending > unverified > ok", () => {
    const components = [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: "A",
            flow_id: "1",
            navigate_screen: "START",
          },
          {
            type: "FLOW",
            text: "B",
            flow_id: "2",
            navigate_screen: "START",
          },
        ],
      },
    ];
    const ok = (flowId: string): TemplateFlowFacts =>
      found({ flowId, screenIds: ["START"] });

    expect(evaluateTemplateFlowHealth([], {}).state).toBe("none");
    expect(evaluateTemplateFlowHealth(components, { "1": ok("1") }).state).toBe(
      "pending"
    );
    expect(
      evaluateTemplateFlowHealth(components, {
        "1": ok("1"),
        "2": { flowId: "2", state: "unavailable", checkedAt: CHECKED_AT },
      }).state
    ).toBe("unverified");
    expect(
      evaluateTemplateFlowHealth(components, {
        "1": { flowId: "1", state: "missing", checkedAt: CHECKED_AT },
      }).state
    ).toBe("issue");
    expect(
      evaluateTemplateFlowHealth(components, { "1": ok("1"), "2": ok("2") })
        .state
    ).toBe("ok");
  });
});

describe("guards", () => {
  it("accepts only numeric Graph ids", () => {
    expect(isWhatsAppFlowGraphId("2244981489363579")).toBe(true);
    expect(isWhatsAppFlowGraphId("")).toBe(false);
    expect(isWhatsAppFlowGraphId("12a")).toBe(false);
    expect(isWhatsAppFlowGraphId("1".repeat(33))).toBe(false);
    expect(isWhatsAppFlowGraphId(123)).toBe(false);
  });

  it("validates facts read back from a cache or the network", () => {
    expect(isTemplateFlowFacts(found())).toBe(true);
    expect(isTemplateFlowFacts(found({ screenIds: null, name: null }))).toBe(
      true
    );
    expect(
      isTemplateFlowFacts({
        flowId: "1",
        state: "missing",
        checkedAt: CHECKED_AT,
      })
    ).toBe(true);
    expect(isTemplateFlowFacts({ ...found(), checkedAt: "yesterday" })).toBe(
      false
    );
    expect(isTemplateFlowFacts({ ...found(), screenIds: [1] })).toBe(false);
    expect(isTemplateFlowFacts({ ...found(), state: "other" })).toBe(false);
    expect(isTemplateFlowFacts(null)).toBe(false);
  });

  it("never rejects facts for their answer schema", () => {
    expect(isTemplateFlowFacts(found())).toBe(true);
    expect(isTemplateFlowFacts(found({ answerSchema: null }))).toBe(true);
    expect(
      isTemplateFlowFacts(
        found({
          answerSchema: {
            flowName: "demoshop_ai_case",
            digest: "a".repeat(64),
            coverage: "complete",
            endpoint: false,
            fields: [],
          },
        })
      )
    ).toBe(true);
    // Health checks keep working; whoever saves the schema validates it.
    expect(isTemplateFlowFacts({ ...found(), answerSchema: "broken" })).toBe(
      true
    );
  });
});
