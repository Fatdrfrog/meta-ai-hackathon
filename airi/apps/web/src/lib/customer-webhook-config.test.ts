import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";

const mockLookup = jest.fn();
const mockHttpsRequest = jest.fn();
jest.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));
jest.mock("node:https", () => ({
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

import {
  decryptCustomerWebhookSecret,
  encryptCustomerWebhookSecret,
  safeCustomerWebhookFetch,
  validateCustomerWebhookUrl,
} from "./customer-webhook-config";

describe("customer webhook configuration and transport", () => {
  let req: EventEmitter & {
    write: jest.Mock;
    end: jest.Mock;
    destroy: jest.Mock;
  };
  let onResponse: (response: IncomingMessage) => void;
  let socketLookup: LookupFunction;
  const originalSecret = process.env.ENCRYPTION_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENCRYPTION_SECRET = "test-only-webhook-encryption-secret";
    mockLookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    req = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn((error?: Error) => {
        if (error) queueMicrotask(() => req.emit("error", error));
      }),
    });
    mockHttpsRequest.mockImplementation((_url, options, responseCallback) => {
      socketLookup = options.lookup;
      onResponse = responseCallback;
      return req;
    });
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = originalSecret;
  });

  it("encrypts signing secrets with authenticated encryption and reads legacy rows", () => {
    const secret = "whsec_credential";
    const encrypted = encryptCustomerWebhookSecret(secret);
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain(secret);
    expect(decryptCustomerWebhookSecret(encrypted)).toBe(secret);
    expect(decryptCustomerWebhookSecret(secret)).toBe(secret);
    expect(encryptCustomerWebhookSecret(secret)).not.toBe(encrypted);
  });

  it("fails closed on corrupt/versioned encryption instead of using ciphertext as the secret", () => {
    expect(() => decryptCustomerWebhookSecret("enc:v1:broken")).toThrow();
    expect(() => decryptCustomerWebhookSecret("enc:v2:broken")).toThrow();
    const encrypted = encryptCustomerWebhookSecret("whsec_credential");
    process.env.ENCRYPTION_SECRET = "wrong-key";
    expect(() => decryptCustomerWebhookSecret(encrypted)).toThrow();
  });

  it.each([
    "http://events.example.com",
    "ftp://events.example.com",
    "https://events.example.com:444/",
    "https://user:pass@events.example.com/",
    "https://events.example.com/#fragment",
    "https://localhost/",
    "https://LOCALHOST./",
    "https://sub.local/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://10.0.0.1/",
    "https://169.254.169.254/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://[fc00::1]/",
  ])("rejects dangerous endpoint %s without DNS or a socket", async url => {
    await expect(validateCustomerWebhookUrl(url)).rejects.toThrow();
    await expect(
      safeCustomerWebhookFetch(url, { body: "{}" })
    ).rejects.toThrow();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("accepts and normalizes a public HTTPS endpoint", async () => {
    await expect(
      validateCustomerWebhookUrl("https://events.example.com:443/hook")
    ).resolves.toBe("https://events.example.com/hook");
    expect(mockLookup).toHaveBeenCalledWith("events.example.com", {
      all: true,
    });
  });

  it("rejects mixed public/private DNS records and lookup failure", async () => {
    mockLookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.5", family: 4 },
    ]);
    await expect(
      validateCustomerWebhookUrl("https://events.example.com")
    ).rejects.toThrow("public addresses");
    mockLookup.mockRejectedValue(new Error("dns failure"));
    await expect(
      validateCustomerWebhookUrl("https://events.example.com")
    ).rejects.toThrow("could not be resolved");
  });

  it("passes validated addresses directly into the socket lookup callback", async () => {
    const promise = safeCustomerWebhookFetch(
      "https://events.example.com/hook",
      { body: "{}", headers: { "X-Test": "value" } }
    );
    const callback = jest.fn();
    await new Promise<void>(resolve => {
      socketLookup("events.example.com", { all: true }, (...args) => {
        callback(...args);
        resolve();
      });
    });
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(mockHttpsRequest.mock.calls[0][1]).toMatchObject({
      agent: false,
      headers: { "x-test": "value" },
    });
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    onResponse(response as unknown as IncomingMessage);
    response.emit("data", Buffer.from("accepted"));
    response.emit("end");
    expect(await (await promise).text()).toBe("accepted");
  });

  it("blocks a DNS rebind at socket creation even after registration validated a public host", async () => {
    await validateCustomerWebhookUrl("https://events.example.com");
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const promise = safeCustomerWebhookFetch("https://events.example.com", {
      body: "{}",
    });
    const callback = jest.fn((error: NodeJS.ErrnoException | null) => {
      if (error) req.destroy(error);
    });
    socketLookup("events.example.com", {}, callback);
    await expect(promise).rejects.toThrow("public addresses");
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it.each([302, 307])("rejects redirect status %s", async statusCode => {
    const promise = safeCustomerWebhookFetch("https://events.example.com", {
      body: "{}",
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode,
      destroy: jest.fn(),
    });
    onResponse(response as unknown as IncomingMessage);
    await expect(promise).rejects.toThrow("redirects are not allowed");
    expect(response.destroy).toHaveBeenCalled();
  });

  it("caps response bytes", async () => {
    const promise = safeCustomerWebhookFetch("https://events.example.com", {
      body: "{}",
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      destroy: jest.fn(),
    });
    onResponse(response as unknown as IncomingMessage);
    response.emit("data", Buffer.alloc(65537));
    await expect(promise).rejects.toThrow("exceeded 64 KiB");
  });

  it.each([600, 700])(
    "rejects non-standard status %s without throwing outside the delivery promise",
    async statusCode => {
      const promise = safeCustomerWebhookFetch("https://events.example.com", {
        body: "{}",
      });
      const response = Object.assign(new EventEmitter(), {
        statusCode,
        destroy: jest.fn(),
      });
      expect(() =>
        onResponse(response as unknown as IncomingMessage)
      ).not.toThrow();
      await expect(promise).rejects.toThrow("invalid HTTP status");
    }
  );

  it("rejects an aborted response", async () => {
    const promise = safeCustomerWebhookFetch("https://events.example.com", {
      body: "{}",
    });
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    onResponse(response as unknown as IncomingMessage);
    response.emit("aborted");
    await expect(promise).rejects.toThrow("before its body was complete");
  });

  it("bounds total request time including connection/DNS delay", async () => {
    jest.useFakeTimers();
    try {
      const promise = safeCustomerWebhookFetch("https://events.example.com", {
        body: "{}",
      });
      const rejected = expect(promise).rejects.toThrow("timed out");
      await jest.advanceTimersByTimeAsync(10001);
      await rejected;
    } finally {
      jest.useRealTimers();
    }
  });
});
