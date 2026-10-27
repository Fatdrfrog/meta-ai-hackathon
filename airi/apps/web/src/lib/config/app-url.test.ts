import {
  parseCanonicalAppUrl,
  parsePublicHttpsOrigin,
  readConfiguredEnvValue,
} from "./app-url";

describe("readConfiguredEnvValue", () => {
  it.each([
    [undefined, ""],
    ["", ""],
    ["   ", ""],
    [" https://www.airi.chat ", "https://www.airi.chat"],
  ])("normalizes %p to %p", (input, expected) => {
    expect(readConfiguredEnvValue(input)).toBe(expected);
  });
});

describe("parseCanonicalAppUrl", () => {
  it.each([
    "https://www.airi.chat",
    "https://www.airi.chat/",
    "http://localhost:3000",
  ])("accepts the bare origin %p", value => {
    expect(parseCanonicalAppUrl(value)?.origin).toBe(new URL(value).origin);
  });

  it.each([
    ["not-a-url", "an unparseable value"],
    ["https://www.airi.chat/panel", "a path"],
    ["https://www.airi.chat/?a=1", "a query string"],
    ["https://www.airi.chat/#frag", "a fragment"],
    ["https://user:pass@www.airi.chat", "embedded credentials"],
  ])("rejects %p because it carries %s", value => {
    expect(parseCanonicalAppUrl(value)).toBeNull();
  });
});

describe("parsePublicHttpsOrigin", () => {
  it.each([
    ["https://www.airi.chat", "https://www.airi.chat"],
    ["https://flows.airi.chat/panel/workspaces/", "https://flows.airi.chat"],
    ["https://www.airi.chat/?a=1#frag", "https://www.airi.chat"],
  ])("reduces %p to the origin %p", (value, expected) => {
    expect(parsePublicHttpsOrigin(value)).toBe(expected);
  });

  it.each([
    ["not-a-url", "an unparseable value"],
    ["http://www.airi.chat", "a non-HTTPS scheme"],
    ["https://user:pass@www.airi.chat", "embedded credentials"],
    ["https://localhost", "a local hostname"],
    ["https://127.0.0.1", "a loopback address"],
    ["https://10.0.0.1", "a private address"],
  ])("rejects %p because it uses %s", value => {
    expect(parsePublicHttpsOrigin(value)).toBeNull();
  });
});
