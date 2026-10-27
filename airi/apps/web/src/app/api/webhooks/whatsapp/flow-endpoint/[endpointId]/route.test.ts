/**
 * @jest-environment node
 */

import crypto from "node:crypto";

const mockResolveRuntimeKeys = jest.fn();
const mockCheckRateLimit = jest.fn();

jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  rateLimitPresets: {
    webhook: { requests: 60, window: "1 m", prefix: "webhook" },
  },
  createRateLimiter: jest.fn(() => ({})),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

jest.mock("@/lib/whatsapp/flows/endpoint-security-service", () => ({
  resolveWhatsAppFlowEndpointRuntimeKeys: (...args: unknown[]) =>
    mockResolveRuntimeKeys(...args),
}));

type DynamicFlowEndpointRoute = {
  POST: (
    request: Request,
    context: { params: Promise<{ endpointId: string }> }
  ) => Promise<Response>;
};

type PemKeyPair = {
  publicKey: string;
  privateKey: string;
};

function loadRoute(): DynamicFlowEndpointRoute | null {
  try {
    return jest.requireActual(
      "@/app/api/webhooks/whatsapp/flow-endpoint/[endpointId]/route"
    ) as DynamicFlowEndpointRoute;
  } catch {
    return null;
  }
}

function encryptRequest(payload: unknown, publicKey: string) {
  const aesKey = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey
  );
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKey, iv);
  const encryptedFlowData = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rawBody = JSON.stringify({
    encrypted_flow_data: encryptedFlowData.toString("base64"),
    encrypted_aes_key: encryptedAesKey.toString("base64"),
    initial_vector: iv.toString("base64"),
  });
  return { aesKey, iv, rawBody };
}

function decryptResponse(
  encryptedResponse: string,
  aesKey: Buffer,
  requestIv: Buffer
): unknown {
  const flippedIv = Buffer.alloc(requestIv.length);
  for (let index = 0; index < requestIv.length; index += 1) {
    flippedIv[index] = requestIv[index]! ^ 0xff;
  }
  const bytes = Buffer.from(encryptedResponse, "base64");
  const ciphertext = bytes.subarray(0, -16);
  const authTag = bytes.subarray(-16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", aesKey, flippedIv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

function signPayload(payload: string): string {
  return `sha256=${crypto
    .createHmac("sha256", "meta-secret")
    .update(payload)
    .digest("hex")}`;
}

describe("managed WhatsApp Flow endpoint route", () => {
  const originalMode = process.env.META_WEBHOOK_SIGNATURE_MODE;
  const originalSecret = process.env.META_APP_SECRET;
  let firstKeys: PemKeyPair;
  let secondKeys: PemKeyPair;
  let consoleWarnSpy: jest.SpyInstance;

  beforeAll(() => {
    firstKeys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    secondKeys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  });

  beforeEach(() => {
    consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    process.env.META_WEBHOOK_SIGNATURE_MODE = "enforce";
    process.env.META_APP_SECRET = "meta-secret";
    mockResolveRuntimeKeys.mockReset();
    mockCheckRateLimit.mockReset().mockResolvedValue({
      success: true,
      limit: 60,
      remaining: 59,
      reset: Date.now() + 60_000,
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  afterAll(() => {
    process.env.META_WEBHOOK_SIGNATURE_MODE = originalMode;
    process.env.META_APP_SECRET = originalSecret;
  });

  it("rejects an invalid Meta signature before resolving tenant key material", async () => {
    const route = loadRoute();
    expect(route?.POST).toEqual(expect.any(Function));
    const { rawBody } = encryptRequest(
      { version: "4.0", action: "ping" },
      firstKeys.publicKey
    );

    const response = await route!.POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint/endpoint-1",
        {
          method: "POST",
          headers: { "x-hub-signature-256": "sha256=invalid" },
          body: rawBody,
        }
      ),
      { params: Promise.resolve({ endpointId: "endpoint-1" }) }
    );

    expect(response.status).toBe(401);
    expect(mockResolveRuntimeKeys).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("rate limits untrusted traffic per managed endpoint before key resolution", async () => {
    const route = loadRoute();
    expect(route?.POST).toEqual(expect.any(Function));
    process.env.META_WEBHOOK_SIGNATURE_MODE = "log";
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Date.now() + 30_000,
    });
    const { rawBody } = encryptRequest(
      { version: "4.0", action: "ping" },
      firstKeys.publicKey
    );

    const response = await route!.POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint/endpoint-1",
        {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.11",
            "x-hub-signature-256": "sha256=invalid",
          },
          body: rawBody,
        }
      ),
      { params: Promise.resolve({ endpointId: "endpoint-1" }) }
    );

    expect(response.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "203.0.113.11",
      60
    );
    expect(mockResolveRuntimeKeys).not.toHaveBeenCalled();
  });

  it("decrypts with an eligible fallback generation and encrypts the handler response", async () => {
    const route = loadRoute();
    expect(route?.POST).toEqual(expect.any(Function));
    const encrypted = encryptRequest(
      { version: "4.0", action: "ping" },
      secondKeys.publicKey
    );
    mockResolveRuntimeKeys.mockResolvedValue({
      endpointId: "endpoint-1",
      keyCandidates: [
        { generationId: "active", privateKeyPem: firstKeys.privateKey },
        { generationId: "pending", privateKeyPem: secondKeys.privateKey },
      ],
    });

    const response = await route!.POST(
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint/endpoint-1",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signPayload(encrypted.rawBody),
          },
          body: encrypted.rawBody,
        }
      ),
      { params: Promise.resolve({ endpointId: "endpoint-1" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(
      decryptResponse(await response.text(), encrypted.aesKey, encrypted.iv)
    ).toEqual({ data: { status: "active" } });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it("returns the same opaque key failure for unknown endpoints and unusable key rings", async () => {
    const route = loadRoute();
    expect(route?.POST).toEqual(expect.any(Function));
    const encrypted = encryptRequest(
      { version: "4.0", action: "ping" },
      secondKeys.publicKey
    );
    const request = () =>
      new Request(
        "https://flows.example.test/api/webhooks/whatsapp/flow-endpoint/unknown",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signPayload(encrypted.rawBody),
          },
          body: encrypted.rawBody,
        }
      );

    mockResolveRuntimeKeys.mockResolvedValueOnce(null);
    const unknown = await route!.POST(request(), {
      params: Promise.resolve({ endpointId: "unknown" }),
    });
    mockResolveRuntimeKeys.mockResolvedValueOnce({
      endpointId: "unknown",
      keyCandidates: [
        { generationId: "active", privateKeyPem: firstKeys.privateKey },
      ],
    });
    const unusable = await route!.POST(request(), {
      params: Promise.resolve({ endpointId: "unknown" }),
    });

    expect(unknown.status).toBe(421);
    expect(unusable.status).toBe(421);
    await expect(unknown.text()).resolves.toBe("");
    await expect(unusable.text()).resolves.toBe("");
  });
});
