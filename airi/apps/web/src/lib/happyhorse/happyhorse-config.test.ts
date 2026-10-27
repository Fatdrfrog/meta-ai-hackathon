jest.mock("@/lib/wan/wan-config", () => ({
  getAlibabaApiKey: () => "test-key",
  getAlibabaApiHost: () =>
    "https://workspace.ap-southeast-1.maas.aliyuncs.com",
}));

import {
  getHappyHorseDefaultRatio,
  getHappyHorseI2VModel,
  getHappyHorseModelForMode,
  getHappyHorseR2VModel,
  getHappyHorseT2VModel,
  isHappyHorseConfigured,
  normalizeHappyHorseDuration,
  normalizeHappyHorseRatio,
  normalizeHappyHorseResolution,
} from "./happyhorse-config";

describe("happyhorse-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.HAPPYHORSE_T2V_MODEL;
    delete process.env.HAPPYHORSE_I2V_MODEL;
    delete process.env.HAPPYHORSE_R2V_MODEL;
    delete process.env.HAPPYHORSE_DEFAULT_RATIO;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("defaults models and TikTok-friendly ratio", () => {
    expect(getHappyHorseT2VModel()).toBe("happyhorse-1.1-t2v");
    expect(getHappyHorseI2VModel()).toBe("happyhorse-1.1-i2v");
    expect(getHappyHorseR2VModel()).toBe("happyhorse-1.1-r2v");
    expect(getHappyHorseModelForMode("reference_to_video")).toBe(
      "happyhorse-1.1-r2v"
    );
    expect(getHappyHorseDefaultRatio()).toBe("9:16");
    expect(isHappyHorseConfigured()).toBe(true);
  });

  it("normalizes duration/resolution/ratio/reference count", () => {
    expect(normalizeHappyHorseDuration(5)).toBe(5);
    expect(normalizeHappyHorseDuration(2)).toBeNull();
    expect(normalizeHappyHorseDuration(16)).toBeNull();
    expect(normalizeHappyHorseResolution("720p")).toBe("720P");
    expect(normalizeHappyHorseRatio("9:16")).toBe("9:16");
    expect(normalizeHappyHorseRatio("bad")).toBeNull();
  });
});
