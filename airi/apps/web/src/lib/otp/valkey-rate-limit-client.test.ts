import {
  encodeValkeyCommandForTests,
  parseValkeyResponseForTests,
} from "@icecore/otp-runtime";

describe("Valkey rate limit RESP helpers", () => {
  it("encodes SET NX EX commands without leaking key formatting ambiguity", () => {
    expect(
      encodeValkeyCommandForTests([
        "SET",
        "otp:cooldown:key",
        "1",
        "NX",
        "EX",
        "30",
      ])
    ).toBe(
      "*6\r\n$3\r\nSET\r\n$16\r\notp:cooldown:key\r\n$1\r\n1\r\n$2\r\nNX\r\n$2\r\nEX\r\n$2\r\n30\r\n"
    );
  });

  it("parses simple string and integer replies", () => {
    expect(parseValkeyResponseForTests(Buffer.from("+OK\r\n"))).toBe("OK");
    expect(parseValkeyResponseForTests(Buffer.from(":42\r\n"))).toBe(42);
  });

  it("throws on Valkey error replies", () => {
    expect(() =>
      parseValkeyResponseForTests(Buffer.from("-ERR unavailable\r\n"))
    ).toThrow("ERR unavailable");
  });
});
