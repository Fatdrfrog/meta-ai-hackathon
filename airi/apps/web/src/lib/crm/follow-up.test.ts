import { CRM_ATTENTION_WINDOW_MS, isCrmNoiseCategory } from "./attention";
import {
  deriveCrmCardWarnings,
  deriveCrmFollowUp,
  extractCrmKeyMomentTypes,
} from "./follow-up";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("deriveCrmFollowUp", () => {
  const base = {
    attention: [] as const,
    handoffActive: false,
    keyMomentTypes: [] as string[],
    slaDueAt: new Date("2026-08-27T12:00:00.000Z"),
    lastInboundAt: NOW,
  };

  it("prefers take over, then review quote, then reply, then follow up", () => {
    expect(
      deriveCrmFollowUp({
        ...base,
        handoffActive: true,
        attention: ["needs_reply"],
        keyMomentTypes: ["price_inquiry"],
      })?.kind
    ).toBe("take_over");
    expect(
      deriveCrmFollowUp({
        ...base,
        keyMomentTypes: ["price_inquiry"],
        attention: ["needs_reply"],
      })?.kind
    ).toBe("review_quote");
    expect(
      deriveCrmFollowUp({
        ...base,
        attention: ["needs_reply"],
      })?.kind
    ).toBe("reply");
    expect(
      deriveCrmFollowUp({
        ...base,
        attention: ["ghosted"],
      })?.kind
    ).toBe("follow_up");
  });

  it("falls back to last inbound plus the SLA window when slaDueAt is missing", () => {
    const lastInboundAt = new Date("2026-08-23T12:00:00.000Z");
    expect(
      deriveCrmFollowUp({
        ...base,
        attention: ["ghosted"],
        slaDueAt: null,
        lastInboundAt,
      })
    ).toEqual({
      kind: "follow_up",
      dueAt: new Date(lastInboundAt.getTime() + CRM_ATTENTION_WINDOW_MS),
    });
  });

  it("does not take over after the team already replied", () => {
    expect(
      deriveCrmFollowUp({
        ...base,
        handoffActive: true,
        attention: [],
      })
    ).toBeNull();
  });

  it("returns nothing for stalled-only cards", () => {
    expect(
      deriveCrmFollowUp({
        ...base,
        attention: ["stalled"],
      })
    ).toBeNull();
  });
});

describe("deriveCrmCardWarnings", () => {
  it("flags objections from key moments", () => {
    expect(deriveCrmCardWarnings(["price_inquiry"])).toEqual([]);
    expect(deriveCrmCardWarnings(["objection", "price_inquiry"])).toEqual([
      "objection",
    ]);
  });
});

describe("extractCrmKeyMomentTypes", () => {
  it("reads type from classifier key_moments", () => {
    expect(
      extractCrmKeyMomentTypes([
        { type: "price_inquiry", message_index: 2 },
        { type: "objection", message_index: 4 },
        { nope: true },
      ])
    ).toEqual(["price_inquiry", "objection"]);
  });
});

describe("isCrmNoiseCategory", () => {
  it("treats Support and Spam as noise", () => {
    expect(isCrmNoiseCategory("Support")).toBe(true);
    expect(isCrmNoiseCategory("Spam")).toBe(true);
    expect(isCrmNoiseCategory("Sales")).toBe(false);
    expect(isCrmNoiseCategory(null)).toBe(false);
  });
});
