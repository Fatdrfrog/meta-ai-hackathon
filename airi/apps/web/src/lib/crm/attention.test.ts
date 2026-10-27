import {
  cardMatchesAttentionFilter,
  compareCrmAttentionCards,
  CRM_ATTENTION_WINDOW_MS,
  deriveCrmCardAttention,
  parseCrmAttentionFilter,
} from "./attention";

const NOW = new Date("2026-08-26T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("parseCrmAttentionFilter", () => {
  it("defaults missing and unknown values to attention", () => {
    expect(parseCrmAttentionFilter(null)).toBe("attention");
    expect(parseCrmAttentionFilter(undefined)).toBe("attention");
    expect(parseCrmAttentionFilter("")).toBe("attention");
    expect(parseCrmAttentionFilter("nope")).toBe("attention");
  });

  it("accepts known filters", () => {
    expect(parseCrmAttentionFilter("all")).toBe("all");
    expect(parseCrmAttentionFilter("needs_reply")).toBe("needs_reply");
    expect(parseCrmAttentionFilter("ghosted")).toBe("ghosted");
    expect(parseCrmAttentionFilter("stalled")).toBe("stalled");
  });
});

describe("deriveCrmCardAttention", () => {
  const base = {
    stageKey: "qualified",
    now: NOW,
    lastInboundAt: null as Date | null,
    lastOutboundAt: null as Date | null,
    isUnread: false,
    conversationStatus: "open",
    stageEnteredAt: NOW,
  };

  it("returns nothing for won and lost stages", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        stageKey: "won",
        isUnread: true,
        lastInboundAt: NOW,
      })
    ).toEqual([]);
    expect(
      deriveCrmCardAttention({
        ...base,
        stageKey: "lost",
        lastInboundAt: daysAgo(10),
        stageEnteredAt: daysAgo(10),
      })
    ).toEqual([]);
  });

  it("flags unread or inbound-waiting conversations as needs_reply", () => {
    expect(
      deriveCrmCardAttention({ ...base, isUnread: true })
    ).toEqual(["needs_reply"]);
    expect(
      deriveCrmCardAttention({
        ...base,
        lastInboundAt: NOW,
        lastOutboundAt: daysAgo(1),
      })
    ).toEqual(["needs_reply"]);
  });

  it("does not flag needs_reply after the team already replied", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        isUnread: true,
        lastInboundAt: new Date("2026-08-26T14:17:02.000Z"),
        lastOutboundAt: new Date("2026-08-26T14:21:30.000Z"),
        conversationStatus: "in_progress",
      })
    ).toEqual([]);
  });

  it("does not flag closed conversations as needs_reply", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        isUnread: true,
        conversationStatus: "closed",
      })
    ).toEqual([]);
  });

  it("flags ghosted when the last inbound is older than the SLA window", () => {
    expect(CRM_ATTENTION_WINDOW_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(
      deriveCrmCardAttention({
        ...base,
        lastInboundAt: daysAgo(3),
        lastOutboundAt: daysAgo(2),
      })
    ).toEqual(["ghosted"]);
  });

  it("does not mark needs_reply conversations as ghosted", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        isUnread: true,
        lastInboundAt: daysAgo(4),
      })
    ).toEqual(["needs_reply"]);
  });

  it("flags stalled when the lead sat in a named stage past the window", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        stageEnteredAt: daysAgo(3),
      })
    ).toEqual(["stalled"]);
  });

  it("does not stall unassigned leads", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        stageKey: "unassigned",
        stageEnteredAt: daysAgo(10),
      })
    ).toEqual([]);
  });

  it("uses a custom ghosted window when provided", () => {
    expect(
      deriveCrmCardAttention({
        ...base,
        lastInboundAt: daysAgo(1),
        lastOutboundAt: NOW,
        ghostedAfterMs: 12 * 60 * 60 * 1000,
      })
    ).toEqual(["ghosted"]);
  });
});

describe("cardMatchesAttentionFilter", () => {
  it("requires Sales when salesOnly is on", () => {
    expect(
      cardMatchesAttentionFilter(["needs_reply"], "Support", "attention", true)
    ).toBe(false);
    expect(
      cardMatchesAttentionFilter(["needs_reply"], "Sales", "attention", true)
    ).toBe(true);
  });

  it("matches specific chips", () => {
    expect(
      cardMatchesAttentionFilter(["ghosted"], "Sales", "needs_reply", false)
    ).toBe(false);
    expect(
      cardMatchesAttentionFilter(["ghosted"], "Sales", "ghosted", false)
    ).toBe(true);
    expect(cardMatchesAttentionFilter([], "Sales", "all", false)).toBe(true);
    expect(cardMatchesAttentionFilter([], "Sales", "attention", false)).toBe(
      false
    );
    expect(
      cardMatchesAttentionFilter(
        [],
        "Sales",
        "attention",
        false,
        false,
        "review_quote"
      )
    ).toBe(true);
  });

  it("hides Support and Spam when noise filter is on", () => {
    expect(
      cardMatchesAttentionFilter(["needs_reply"], "Support", "all", false, true)
    ).toBe(false);
    expect(
      cardMatchesAttentionFilter(["needs_reply"], "Sales", "all", false, true)
    ).toBe(true);
  });
});

describe("compareCrmAttentionCards", () => {
  it("orders needs_reply before ghosted, then sooner SLA", () => {
    const reply = {
      attention: ["needs_reply"] as const,
      slaDueAt: new Date("2026-08-27T00:00:00.000Z"),
      lastInboundAt: NOW,
    };
    const ghostedSoon = {
      attention: ["ghosted"] as const,
      slaDueAt: new Date("2026-08-20T00:00:00.000Z"),
      lastInboundAt: daysAgo(5),
    };
    const replySooner = {
      attention: ["needs_reply"] as const,
      slaDueAt: new Date("2026-08-26T00:00:00.000Z"),
      lastInboundAt: NOW,
    };

    expect(compareCrmAttentionCards(reply, ghostedSoon)).toBeLessThan(0);
    expect(compareCrmAttentionCards(replySooner, reply)).toBeLessThan(0);
  });
});
