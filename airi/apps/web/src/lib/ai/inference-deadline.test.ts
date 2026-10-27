import { createInferenceDeadline } from "@/lib/ai/inference-deadline";

describe("createInferenceDeadline", () => {
  it("shares one budget across calls", () => {
    let now = 1_000;
    const deadline = createInferenceDeadline(8_000, () => now);

    expect(deadline.nextTimeoutMs(5_000)).toBe(5_000);
    now += 4_500;
    expect(deadline.nextTimeoutMs(8_000)).toBe(3_500);
    expect(deadline.remainingMs()).toBe(3_500);
  });

  it("refuses a provider call when too little budget remains", () => {
    let now = 10_000;
    const deadline = createInferenceDeadline(2_000, () => now);
    now += 1_250;

    expect(deadline.nextTimeoutMs(5_000)).toBeNull();
    expect(deadline.nextTimeoutMs(5_000, 500)).toBe(750);
  });
});
