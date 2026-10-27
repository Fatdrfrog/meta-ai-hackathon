/**
 * @jest-environment node
 */

import { getAlibabaApiHost } from "./wan-config";

describe("getAlibabaApiHost", () => {
  const previous = process.env.ALIBABA_API_HOST;

  afterEach(() => {
    if (previous === undefined) delete process.env.ALIBABA_API_HOST;
    else process.env.ALIBABA_API_HOST = previous;
  });

  it("prepends https when the env host has no scheme", () => {
    process.env.ALIBABA_API_HOST =
      "ws-25bv2tcn06f5cy3t.ap-southeast-1.maas.aliyuncs.com";
    expect(getAlibabaApiHost()).toBe(
      "https://ws-25bv2tcn06f5cy3t.ap-southeast-1.maas.aliyuncs.com"
    );
  });

  it("keeps an existing https scheme and strips /api/v1", () => {
    process.env.ALIBABA_API_HOST =
      "https://ws-25bv2tcn06f5cy3t.ap-southeast-1.maas.aliyuncs.com/api/v1/";
    expect(getAlibabaApiHost()).toBe(
      "https://ws-25bv2tcn06f5cy3t.ap-southeast-1.maas.aliyuncs.com"
    );
  });
});
