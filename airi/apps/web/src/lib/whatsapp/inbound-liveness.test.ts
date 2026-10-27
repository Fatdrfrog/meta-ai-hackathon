import {
  WHATSAPP_INBOUND_LIVENESS_DEFAULTS,
  WHATSAPP_INBOUND_LIVENESS_PLATFORM_CONFIG,
  decideWhatsAppInboundLivenessTransition,
  evaluateWhatsAppInboundLiveness,
  getVisibleWhatsAppInboundSilence,
  readWhatsAppInboundLivenessOutages,
  readWhatsAppInboundSilenceFlag,
} from "./inbound-liveness";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Monday 2026-10-12 00:00 UTC.
const MONDAY = Date.parse("2026-10-12T00:00:00.000Z");

/** `perHour` messages each hour from `fromHour` to `toHour` UTC, every day. */
function businessHours({
  firstDay,
  days,
  perHour = 3,
  fromHour = 4,
  toHour = 16,
}: {
  firstDay: number;
  days: number;
  perHour?: number;
  fromHour?: number;
  toHour?: number;
}) {
  const times: number[] = [];
  for (let day = 0; day < days; day += 1) {
    for (let hour = fromHour; hour < toHour; hour += 1) {
      for (let index = 0; index < perHour; index += 1) {
        times.push(
          firstDay + day * DAY + hour * HOUR + (index * HOUR) / perHour
        );
      }
    }
  }
  return times;
}

const twoWeeks = businessHours({ firstDay: MONDAY - 14 * DAY, days: 14 });
const lastBusy = twoWeeks.at(-1)!;
const evaluate = (
  inboundTimes: number[],
  now: number,
  sinceDays = 21,
  config = WHATSAPP_INBOUND_LIVENESS_DEFAULTS
) =>
  evaluateWhatsAppInboundLiveness({
    inboundTimes,
    now: new Date(now),
    monitoredSince: new Date(MONDAY - sinceDays * DAY),
    config,
  });

describe("evaluateWhatsAppInboundLiveness", () => {
  it("has no baseline for a number that never received anything", () => {
    expect(evaluate([], MONDAY)).toEqual({
      state: "insufficient_baseline",
      lastInboundAt: null,
    });
  });

  it("never flags a silence shorter than 20 hours", () => {
    expect(WHATSAPP_INBOUND_LIVENESS_DEFAULTS.minSilenceMs).toBe(20 * HOUR);
    expect(evaluate(twoWeeks, lastBusy + 19 * HOUR).state).toBe("ok");
  });

  it("flags a busy number once its usual working hours pass without messages", () => {
    // Sunday 15:40 to Monday 12:00: over 20 h, covering a busy morning.
    const verdict = evaluate(twoWeeks, MONDAY + 12 * HOUR);

    expect(verdict).toMatchObject({
      state: "silent",
      lastInboundAt: new Date(lastBusy),
      referenceDays: 14,
      activeReferenceDays: 14,
    });
  });

  it("does not flag a long gap that only covers stretches this number is quiet in", () => {
    // Traffic only 08:00-10:00 UTC. From Sunday 09:40 to Monday 07:00 is
    // over 20 h, but on earlier days the same stretch held only the 09:40
    // message.
    const mornings = businessHours({
      firstDay: MONDAY - 14 * DAY,
      days: 14,
      fromHour: 8,
      toHour: 10,
    });
    const now = MONDAY + 7 * HOUR;

    expect(now - mornings.at(-1)!).toBeGreaterThan(20 * HOUR);
    expect(evaluate(mornings, now).state).toBe("ok");
  });

  it("does not flag a number whose quiet stretch is ordinary for it", () => {
    // Activity on only every other day: a missing day is normal.
    const everyOtherDay = twoWeeks.filter(
      time => Math.floor((time - MONDAY) / DAY) % 2 === 0
    );

    expect(evaluate(everyOtherDay, MONDAY + 20 * HOUR).state).toBe("ok");
  });

  it("keeps comparing with days before a long silence began", () => {
    // Four silent days must not become their own baseline.
    expect(evaluate(twoWeeks, MONDAY + 4 * DAY + 12 * HOUR).state).toBe(
      "silent"
    );
  });

  describe("with exactly one earlier day to compare with", () => {
    // History since Saturday 00:00; Sunday 15:40 to Monday 12:00 leaves room
    // for the Saturday-Sunday window only.
    const weekend = businessHours({ firstDay: MONDAY - 2 * DAY, days: 2 });
    const now = MONDAY + 12 * HOUR;

    it("has no baseline yet", () => {
      expect(evaluate(weekend, now, 2).state).toBe("insufficient_baseline");
    });

    it("would judge it if one day were enough", () => {
      expect(
        evaluate(weekend, now, 2, {
          ...WHATSAPP_INBOUND_LIVENESS_DEFAULTS,
          minReferenceDays: 1,
        }).state
      ).toBe("silent");
    });
  });

  it.each([
    ["a young number with steady traffic", 30, "silent"],
    ["a young number with a few test messages", 1, "ok"],
  ])("judges %s by its volume", (_label, perHour, state) => {
    // Under three days of history, as source 7448749f had, then a silence.
    const young = businessHours({
      firstDay: MONDAY - 3 * DAY,
      days: 3,
      perHour,
    });

    expect(evaluate(young, MONDAY + 12 * HOUR, 3).state).toBe(state);
  });

  it("ignores receipts after the check time", () => {
    const withFuture = [...twoWeeks, MONDAY + 30 * HOUR];

    expect(evaluate(withFuture, MONDAY + 12 * HOUR).state).toBe("silent");
  });

  describe("longest earlier gap", () => {
    /** Busy every day, except whole days counted back from Monday. */
    const busyExcept = (days: number, quietDaysBack: number[]) =>
      businessHours({ firstDay: MONDAY - days * DAY, days }).filter(
        time => !quietDaysBack.includes(Math.ceil((MONDAY - time) / DAY))
      );
    const lastSunday = MONDAY - DAY + 15 * HOUR + 40 * 60 * 1000;
    // Sunday 15:40 to Monday 22:00.
    const thirtyHoursLater = MONDAY + 22 * HOUR;
    const withoutGapRule = {
      ...WHATSAPP_INBOUND_LIVENESS_DEFAULTS,
      gapHistoryMs: 0,
    };

    it("does not flag a silence shorter than a gap the number had within five weeks", () => {
      // Quiet for two days three weeks ago: a 60 h gap, before the reference
      // days, so the same-stretch comparison alone still flags the silence.
      const history = busyExcept(28, [22, 21]);

      expect(history.at(-1)).toBe(lastSunday);
      expect(
        evaluate(history, thirtyHoursLater, 35, withoutGapRule).state
      ).toBe("silent");
      expect(evaluate(history, thirtyHoursLater, 35).state).toBe("ok");
    });

    it("flags a silence that outlasts every earlier gap", () => {
      const history = busyExcept(28, [22, 21]);
      // Sunday 15:40 to Wednesday 04:40: 61 h, past the 60 h 20 min gap.
      const verdict = evaluate(
        history,
        MONDAY + 2 * DAY + 4 * HOUR + 40 * 60 * 1000,
        35
      );

      expect(verdict).toMatchObject({
        state: "silent",
        longestGapMs: 60 * HOUR + 20 * 60 * 1000,
      });
    });

    it("forgets gaps older than five weeks", () => {
      const history = busyExcept(48, [41, 40]);

      expect(evaluate(history, thirtyHoursLater, 55)).toMatchObject({
        state: "silent",
        // The nightly gap, 15:40 to 04:00.
        longestGapMs: 12 * HOUR + 20 * 60 * 1000,
      });
    });

    it("counts a gap the five-week window starts inside", () => {
      // Quiet days 37-34 back: the window opens 35 days before Sunday 15:40,
      // so 60 h 20 min of that gap still falls inside it.
      const history = busyExcept(48, [37, 36, 35, 34]);

      expect(evaluate(history, thirtyHoursLater, 55).state).toBe("ok");
    });

    it("does not count earlier gaps beyond the monitored history", () => {
      // The same gap, but the source was connected after it ended.
      const history = busyExcept(48, [37, 36, 35, 34]).filter(
        time => time >= MONDAY - 33 * DAY
      );

      expect(evaluate(history, thirtyHoursLater, 33).state).toBe("silent");
    });

    it("measures a cut-through gap from the window start, not its true start", () => {
      // 60 h 20 min of the 108 h 20 min gap is inside the window: a 61 h
      // silence outlasts it.
      const history = busyExcept(48, [37, 36, 35, 34]);
      const sixtyOneHours = MONDAY + 2 * DAY + 4 * HOUR + 40 * 60 * 1000;

      expect(evaluate(history, sixtyOneHours, 55).state).toBe("silent");
    });

    it("never counts the time before a source was connected as a gap", () => {
      // The number had receipts 48-45 days back, the source was created 30
      // days back and traffic started 20 days back.
      const history = [
        ...businessHours({ firstDay: MONDAY - 48 * DAY, days: 4 }),
        ...businessHours({ firstDay: MONDAY - 20 * DAY, days: 20 }),
      ];

      expect(evaluate(history, thirtyHoursLater, 30).state).toBe("silent");
    });

    it("treats a silence exactly as long as the earlier gap as ordinary", () => {
      const history = busyExcept(28, [22, 21]);
      const sameLength = lastSunday + 60 * HOUR + 20 * 60 * 1000;

      expect(evaluate(history, sameLength, 35).state).toBe("ok");
    });

    describe("with a recorded outage", () => {
      const history = busyExcept(28, [22, 21]);
      // The 60 h 20 min gap: Friday 15:40 three weeks back to Monday 04:00.
      const gapFrom = MONDAY - 23 * DAY + 15 * HOUR + 40 * 60 * 1000;
      const gapTo = MONDAY - 20 * DAY + 4 * HOUR;
      const evaluateWith = (outages: { fromMs: number; toMs: number }[]) =>
        evaluateWhatsAppInboundLiveness({
          inboundTimes: history,
          now: new Date(thirtyHoursLater),
          monitoredSince: new Date(MONDAY - 35 * DAY),
          outages,
        });

      it("does not let the outage set the bar for the next silence", () => {
        expect(evaluateWith([{ fromMs: gapFrom, toMs: gapTo }])).toMatchObject({
          state: "silent",
          longestGapMs: 12 * HOUR + 20 * 60 * 1000,
        });
      });

      it("ignores a gap mostly covered by an outage recorded a little late", () => {
        // The recovery run saw a message 50 min after the first one back.
        expect(
          evaluateWith([{ fromMs: gapFrom, toMs: gapTo + 50 * 60 * 1000 }])
            .state
        ).toBe("silent");
      });

      it("still counts a gap an outage only touches", () => {
        expect(
          evaluateWith([{ fromMs: gapTo - 6 * HOUR, toMs: gapTo + 6 * HOUR }])
            .state
        ).toBe("ok");
      });
    });

    it("is off for the platform-wide check", () => {
      const history = busyExcept(28, [22, 21]);

      expect(WHATSAPP_INBOUND_LIVENESS_PLATFORM_CONFIG.gapHistoryMs).toBe(0);
      expect(
        evaluate(
          history,
          thirtyHoursLater,
          35,
          WHATSAPP_INBOUND_LIVENESS_PLATFORM_CONFIG
        ).state
      ).toBe("silent");
    });
  });
});

describe("decideWhatsAppInboundLivenessTransition", () => {
  const now = new Date(MONDAY + 12 * HOUR);
  const silentVerdict = evaluate(twoWeeks, now.getTime());
  const decide = (
    credentials: Record<string, unknown>,
    overrides: Partial<
      Parameters<typeof decideWhatsAppInboundLivenessTransition>[0]
    > = {}
  ) =>
    decideWhatsAppInboundLivenessTransition({
      credentials,
      phoneNumberId: "phone-1",
      verdict: silentVerdict,
      now,
      ...overrides,
    });
  const flagged = {
    phone_number_id: "phone-1",
    inbound_liveness_status: "silent",
    inbound_liveness_phone_number_id: "phone-1",
    inbound_liveness_silent_since: new Date(lastBusy).toISOString(),
    inbound_liveness_checked_at: new Date(now.getTime() - HOUR).toISOString(),
  };
  const cleared = {
    inbound_liveness_status: null,
    inbound_liveness_phone_number_id: null,
    inbound_liveness_silent_since: null,
    inbound_liveness_detected_at: null,
    inbound_liveness_checked_at: null,
  };

  it("marks a newly silent number for its current phone", () => {
    expect(decide({})).toEqual({
      kind: "silent",
      silentSince: new Date(lastBusy),
      patch: {
        inbound_liveness_status: "silent",
        inbound_liveness_phone_number_id: "phone-1",
        inbound_liveness_silent_since: new Date(lastBusy).toISOString(),
        inbound_liveness_detected_at: now.toISOString(),
        inbound_liveness_checked_at: now.toISOString(),
      },
    });
  });

  it("leaves the silence to a warning that already explains it", () => {
    expect(decide({}, { mayBecomeSilent: false })).toEqual({ kind: "none" });
  });

  it("only confirms a silence it already reported", () => {
    expect(decide(flagged)).toEqual({
      kind: "still_silent",
      silentSince: new Date(lastBusy),
      patch: { inbound_liveness_checked_at: now.toISOString() },
    });
  });

  it("clears the flag with nulls when a message arrives, leaving recorded outages alone", () => {
    const backAt = new Date(now.getTime() + HOUR);

    // A recovered flag is never recorded as an outage: a weekend lull that
    // was flagged would otherwise stop counting as ordinary for the number.
    expect(
      decide(
        {
          ...flagged,
          inbound_liveness_outages: [
            {
              phone_number_id: "phone-1",
              from: "2026-10-01T06:49:00.000Z",
              to: "2026-10-03T07:52:00.000Z",
            },
          ],
        },
        {
          verdict: { state: "ok", lastInboundAt: backAt },
          now: new Date(backAt.getTime() + 5 * 60 * 1000),
        }
      )
    ).toEqual({
      kind: "recovered",
      silentSince: new Date(lastBusy),
      lastInboundAt: backAt,
      patch: cleared,
    });
  });

  it("reads the outages of one number only", () => {
    const outage = {
      phone_number_id: "phone-1",
      from: "2026-10-01T06:49:00.000Z",
      to: "2026-10-03T07:52:00.000Z",
    };
    const credentials = {
      inbound_liveness_outages: [
        outage,
        { ...outage, phone_number_id: "phone-2" },
        { ...outage, to: outage.from },
        "junk",
      ],
    };

    expect(readWhatsAppInboundLivenessOutages(credentials, "phone-1")).toEqual([
      { fromMs: Date.parse(outage.from), toMs: Date.parse(outage.to) },
    ]);
    expect(readWhatsAppInboundLivenessOutages({}, "phone-1")).toEqual([]);
  });

  it("drops a flag raised for the number the source used before", () => {
    expect(decide(flagged, { phoneNumberId: "phone-2" })).toEqual({
      kind: "cleared",
      patch: cleared,
    });
  });

  it("reads only a well-formed silent flag", () => {
    expect(readWhatsAppInboundSilenceFlag({})).toBeNull();
    expect(
      readWhatsAppInboundSilenceFlag({
        ...flagged,
        inbound_liveness_status: null,
      })
    ).toBeNull();
    expect(
      readWhatsAppInboundSilenceFlag({
        ...flagged,
        inbound_liveness_silent_since: "not a date",
      })
    ).toBeNull();
  });
});

describe("getVisibleWhatsAppInboundSilence", () => {
  const checkedAt = MONDAY + 12 * HOUR;
  const flagged = {
    phone_number_id: "phone-1",
    inbound_liveness_status: "silent",
    inbound_liveness_phone_number_id: "phone-1",
    inbound_liveness_silent_since: "2026-10-11T15:40:00.000Z",
    inbound_liveness_checked_at: new Date(checkedAt).toISOString(),
  };

  it("shows a silence a recent run confirmed", () => {
    expect(getVisibleWhatsAppInboundSilence(flagged, checkedAt + HOUR)).toEqual(
      new Date("2026-10-11T15:40:00.000Z")
    );
  });

  it("hides it once runs stop confirming it", () => {
    expect(
      getVisibleWhatsAppInboundSilence(flagged, checkedAt + 4 * HOUR)
    ).toBeNull();
  });

  it("hides it after the source switched numbers", () => {
    expect(
      getVisibleWhatsAppInboundSilence(
        { ...flagged, phone_number_id: "phone-2" },
        checkedAt
      )
    ).toBeNull();
  });
});
