const mockRequest = jest.fn();
const mockReady = jest.fn();
const mockReadinessAllowed = jest.fn();
const mockSubmissionAllowed = jest.fn();
jest.mock("@/lib/landing/template-delivery.server", () => ({
  getPublicTemplateReadiness: (...args: unknown[]) => mockReady(...args),
  requestPublicTemplate: (...args: unknown[]) => mockRequest(...args),
  assertPublicTemplateReadinessRequestAllowed: (...args: unknown[]) =>
    mockReadinessAllowed(...args),
  assertPublicTemplateSubmissionRequestAllowed: (...args: unknown[]) =>
    mockSubmissionAllowed(...args),
  PublicTemplateDeliveryError: class PublicTemplateDeliveryError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly retryAfter?: number
    ) {
      super(code);
    }
  },
}));

import { GET, POST } from "./route";
import { PublicTemplateDeliveryError } from "@/lib/landing/template-delivery.server";
import { PUBLIC_TEMPLATE_CONSENT_VERSION } from "@/lib/landing/template-request";

const body = {
  templateId: "welcome",
  locale: "en",
  name: "Sam",
  email: "Sam@Company.com",
  phone: "+77001234567",
  consent: true,
  consentVersion: PUBLIC_TEMPLATE_CONSENT_VERSION,
  website: "",
  requestId: "35f5218c-5d38-4d2a-87d0-f2ac0206a1fd",
  source: "marketplace",
};
const savedVercel = process.env.VERCEL;
function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/landing/template-request", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.VERCEL = "1";
  mockSubmissionAllowed.mockResolvedValue(undefined);
  mockRequest.mockResolvedValue({ status: "accepted" });
  mockReady.mockResolvedValue({
    readyTemplateIds: ["welcome"],
    unavailableTemplateIds: [],
  });
});
afterAll(() => {
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
});

it("ignores forged forwarding headers outside Vercel", async () => {
  delete process.env.VERCEL;
  const response = await POST(
    request(body, {
      "x-vercel-forwarded-for": "198.51.100.8",
      "x-forwarded-for": "203.0.113.1",
      "x-real-ip": "192.0.2.1",
    })
  );
  expect(response.status).toBe(200);
  expect(mockSubmissionAllowed).toHaveBeenCalledWith("unknown");
  expect(mockRequest).toHaveBeenCalledWith(expect.anything(), "unknown");
});

it.each([undefined, "not-an-ip", "198.51.100.8, 203.0.113.1"])(
  "does not fall back to untrusted IP headers when the Vercel header is %s",
  async protectedIp => {
    const headers: Record<string, string> = {
      "x-forwarded-for": "203.0.113.1",
      "x-real-ip": "192.0.2.1",
    };
    if (protectedIp) headers["x-vercel-forwarded-for"] = protectedIp;
    const response = await POST(request(body, headers));
    expect(response.status).toBe(200);
    expect(mockSubmissionAllowed).toHaveBeenCalledWith("unknown");
    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), "unknown");
  }
);

it.each([
  ["::ffff:198.51.100.8", "198.51.100.8"],
  ["2001:0db8:1234:abcd::1", "2001:db8:1234:abcd::/64"],
  ["2001:db8:1234:abcd:ffff:ffff:ffff:ffff", "2001:db8:1234:abcd::/64"],
])("uses one protected network bucket for %s", async (ip, identity) => {
  await POST(request(body, { "x-vercel-forwarded-for": ip }));
  expect(mockSubmissionAllowed).toHaveBeenCalledWith(identity);
  expect(mockRequest).toHaveBeenCalledWith(expect.anything(), identity);
});

it("uses the same protected identity for readiness requests", async () => {
  delete process.env.VERCEL;
  await GET(
    new Request("http://localhost/api/landing/template-request?locale=en", {
      headers: { "x-vercel-forwarded-for": "198.51.100.8" },
    })
  );
  expect(mockReadinessAllowed).toHaveBeenCalledWith("unknown");
});

it("rejects cross-site browser requests even without an Origin header", async () => {
  const response = await POST(
    request(body, { "sec-fetch-site": "cross-site" })
  );
  expect(response.status).toBe(400);
  expect(mockSubmissionAllowed).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});

it.each(["rate_limited", "unavailable"])(
  "fails closed at ingress for %s without reading the body",
  async code => {
    const status = code === "rate_limited" ? 429 : 503;
    mockSubmissionAllowed.mockRejectedValue(
      new (PublicTemplateDeliveryError as unknown as new (
        code: string,
        status: number,
        retry?: number
      ) => Error)(code, status, code === "rate_limited" ? 60 : undefined)
    );
    const submission = request();
    const readBody = jest.spyOn(submission.body!, "getReader");
    const response = await POST(submission);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ code });
    if (code === "rate_limited")
      expect(response.headers.get("retry-after")).toBe("60");
    expect(readBody).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);

it.each([
  ["malformed JSON", "not-json", 400],
  ["invalid input", JSON.stringify({ ...body, requestId: "bad" }), 400],
  ["unbound template", JSON.stringify({ ...body, templateId: "unknown" }), 400],
  ["oversized input", JSON.stringify({ ...body, name: "x".repeat(5000) }), 400],
  ["honeypot", JSON.stringify({ ...body, website: "spam.example" }), 200],
])(
  "charges ingress for %s before validation or discard",
  async (_label, raw, status) => {
    const response = await POST(
      new Request("http://localhost/api/landing/template-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      })
    );
    expect(response.status).toBe(status);
    expect(mockSubmissionAllowed).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  }
);

it("uses the requested locale and returns only public readiness IDs", async () => {
  const response = await GET(
    new Request("http://localhost/api/landing/template-request?locale=ru")
  );
  expect(mockReady).toHaveBeenCalledWith("ru");
  await expect(response.json()).resolves.toEqual({
    readyTemplateIds: ["welcome"],
    unavailableTemplateIds: [],
  });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("keeps working demos available while reporting exact temporary Flow outages", async () => {
  mockReady.mockResolvedValue({
    readyTemplateIds: ["welcome"],
    unavailableTemplateIds: ["appointment-booking"],
  });
  const response = await GET(
    new Request("http://localhost/api/landing/template-request?locale=en")
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    readyTemplateIds: ["welcome"],
    unavailableTemplateIds: ["appointment-booking"],
  });
});

it("reports configured readiness outages separately from coming-soon templates", async () => {
  mockReady.mockRejectedValue(
    new (PublicTemplateDeliveryError as unknown as new (
      code: string,
      status: number
    ) => Error)("unavailable", 503)
  );
  const response = await GET(
    new Request("http://localhost/api/landing/template-request?locale=en")
  );
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ code: "unavailable" });
});

it("normalizes a valid request and uses the trusted Vercel proxy IP", async () => {
  const response = await POST(
    request(body, {
      "x-vercel-forwarded-for": "198.51.100.8",
      "x-forwarded-for": "203.0.113.1, 10.0.0.1",
    })
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: "accepted" });
  expect(mockRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      email: "sam@company.com",
      consentVersion: PUBLIC_TEMPLATE_CONSENT_VERSION,
    }),
    "198.51.100.8"
  );
});

it.each([
  { consent: false },
  { consentVersion: undefined },
  { consentVersion: "public-template-demo-v1" },
  { templateId: "private-template" },
  { phone: "87001234567" },
  { requestId: "bad-id" },
  { components: [] },
])(
  "rejects invalid or unauthorized send input before dispatch: %j",
  invalid => {
    return POST(request({ ...body, ...invalid })).then(response => {
      expect(response.status).toBe(400);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  }
);

it("quietly discards honeypots without collecting or sending", async () => {
  const response = await POST(
    request({ ...body, website: "https://spam.example" })
  );
  expect(response.status).toBe(200);
  expect(mockRequest).not.toHaveBeenCalled();
});

it("reports durable in-flight or unknown requests as processing", async () => {
  mockRequest.mockResolvedValue({ status: "processing" });
  const response = await POST(request());
  expect(response.status).toBe(202);
  await expect(response.json()).resolves.toEqual({ status: "processing" });
});

it("provides bounded retry guidance without leaking provider details", async () => {
  mockRequest.mockRejectedValue(
    new (PublicTemplateDeliveryError as unknown as new (
      code: string,
      status: number,
      retry: number
    ) => Error)("rate_limited", 429, 60)
  );
  const response = await POST(request());
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  await expect(response.json()).resolves.toEqual({ code: "rate_limited" });
});

it("rejects oversized and cross-origin requests before dispatch", async () => {
  expect(
    (await POST(request({ ...body, name: "x".repeat(5000) }))).status
  ).toBe(400);
  expect(
    (await POST(request(body, { origin: "https://untrusted.example" }))).status
  ).toBe(400);
  expect(mockRequest).not.toHaveBeenCalled();
});

it("does not leak unexpected errors", async () => {
  mockRequest.mockRejectedValue(new Error("private token and phone"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ code: "unknown" });
});
