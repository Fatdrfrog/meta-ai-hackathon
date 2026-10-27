import crypto from "crypto";

const mockAdminFrom = jest.fn();
const mockInsert = jest.fn();
const mockCreateSessionClient = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockAdminFrom(...args),
  },
}));

// Meta calls this callback without a user session; the session client is
// anon there, and only the service role may write deletion requests.
jest.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => mockCreateSessionClient(...args),
}));

import { POST } from "./route";

const APP_SECRET = "test-meta-app-secret";

function signedRequest(payload: Record<string, unknown>): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const signature = crypto
    .createHmac("sha256", APP_SECRET)
    .update(encodedPayload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `${signature}.${encodedPayload}`;
}

const validSignedRequest = () =>
  signedRequest({ user_id: "meta-user-1", issued_at: 1_790_000_000 });
const CALLBACK_URL = "https://www.airi.chat/api/webhooks/data-deletion";

function deletionRequest(
  body: unknown = { signed_request: validSignedRequest() }
) {
  return new Request(CALLBACK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Meta posts the parameter as a form field, like PHP's $_POST['signed_request'].
function formDeletionRequest(signed: string = validSignedRequest()) {
  return new Request(CALLBACK_URL, {
    method: "POST",
    body: new URLSearchParams({ signed_request: signed }),
  });
}

describe("POST /api/webhooks/data-deletion", () => {
  const originalSecret = process.env.META_APP_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.META_APP_SECRET = APP_SECRET;
    mockAdminFrom.mockReturnValue({ insert: mockInsert });
    mockInsert.mockResolvedValue({ data: null, error: null });
  });

  afterAll(() => {
    if (originalSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = originalSecret;
  });

  it("records the request with the server client before confirming it to Meta", async () => {
    const response = await POST(deletionRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAdminFrom).toHaveBeenCalledWith("data_deletion_requests");
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        facebook_user_id: "meta-user-1",
        confirmation_code: body.confirmation_code,
        status: "pending",
      })
    );
    expect(body.url).toContain(`id=${body.confirmation_code}`);
    expect(mockCreateSessionClient).not.toHaveBeenCalled();
  });

  it("does not hand Meta a confirmation code when the request was not saved", async () => {
    mockInsert.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "new row violates row-level security" },
    });

    const response = await POST(deletionRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).not.toHaveProperty("confirmation_code");
  });

  it("reads Meta's form-encoded signed_request and records it", async () => {
    const request = formDeletionRequest();
    expect(request.headers.get("content-type")).toContain(
      "application/x-www-form-urlencoded"
    );

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        facebook_user_id: "meta-user-1",
        confirmation_code: body.confirmation_code,
        request_timestamp: new Date(1_790_000_000 * 1000).toISOString(),
      })
    );
  });

  it("reads a multipart signed_request", async () => {
    const form = new FormData();
    form.set("signed_request", validSignedRequest());

    const response = await POST(
      new Request(CALLBACK_URL, { method: "POST", body: form })
    );

    expect(response.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Request]>([
    ["a missing JSON field", () => deletionRequest({})],
    ["a non-string JSON field", () => deletionRequest({ signed_request: 42 })],
    [
      "malformed JSON",
      () =>
        new Request(CALLBACK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
    ],
    ["a value without a signature separator", () => formDeletionRequest("abc")],
    ["an empty form", () => formDeletionRequest("")],
    [
      "a body without a content type",
      () => new Request(CALLBACK_URL, { method: "POST" }),
    ],
  ])("rejects %s with 400 before any write", async (_label, build) => {
    const response = await POST(build());

    expect(response.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects a forged or truncated signature with 403", async () => {
    const [signature, payload] = validSignedRequest().split(".");
    const forged = `${signature.slice(0, -2)}AA.${payload}`;
    const truncated = `${signature.slice(0, 10)}.${payload}`;

    for (const value of [forged, truncated]) {
      const response = await POST(formDeletionRequest(value));
      expect(response.status).toBe(403);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("does not echo internal error text to the caller", async () => {
    mockAdminFrom.mockImplementation(() => {
      throw new Error("connection string postgres://user:secret@db");
    });
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const response = await POST(formDeletionRequest());
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({
        error: "Failed to process data deletion request",
      });
      expect(text).not.toContain("secret");
    } finally {
      consoleError.mockRestore();
    }
  });
});
