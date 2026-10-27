import { formatAudioPlayerTime } from "./audio-player";

describe("formatAudioPlayerTime", () => {
  it("formats finite media times", () => {
    expect(formatAudioPlayerTime(3.7)).toBe("0:03");
    expect(formatAudioPlayerTime(65)).toBe("1:05");
    expect(formatAudioPlayerTime(3661.9)).toBe("1:01:01");
  });

  it("hides invalid media durations", () => {
    expect(formatAudioPlayerTime(Number.POSITIVE_INFINITY)).toBe("--:--");
    expect(formatAudioPlayerTime(Number.NEGATIVE_INFINITY)).toBe("--:--");
    expect(formatAudioPlayerTime(Number.NaN)).toBe("--:--");
    expect(formatAudioPlayerTime(undefined)).toBe("--:--");
    expect(formatAudioPlayerTime(null)).toBe("--:--");
  });
});
