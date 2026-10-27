const mockSource = jest.fn();
const mockLimit = jest.fn();
const mockReserve = jest.fn();
const mockSettle = jest.fn();
const mockRead = jest.fn();
const mockUpload = jest.fn();
const mockInfo = jest.fn();
const mockSign = jest.fn();
const mockVerify = jest.fn();
const mockVisitor = jest.fn();

jest.mock("@/lib/widget/source-context", () => ({
  resolveAuthorizedWidgetSource: (...args: unknown[]) => mockSource(...args),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: () => ({}),
  checkCriticalRateLimit: (...args: unknown[]) => mockLimit(...args),
}));
jest.mock("@icecore/airi-runtime/storage-quota", () => ({
  storeSupabaseWorkspaceBuffer: jest.requireActual(
    "@icecore/airi-runtime/storage-quota"
  ).storeSupabaseWorkspaceBuffer,
  reserveWorkspaceStorage: (...args: unknown[]) => mockReserve(...args),
  settleStorageObject: (...args: unknown[]) => mockSettle(...args),
  readStorageObject: (...args: unknown[]) => mockRead(...args),
  StorageQuotaError: class StorageQuotaError extends Error {},
}));
jest.mock("@/lib/widget/visitor-auth", () => ({
  generateWidgetUploadToken: (...args: unknown[]) => mockSign(...args),
  verifyWidgetUploadToken: (...args: unknown[]) => mockVerify(...args),
  verifyVisitorToken: (...args: unknown[]) => mockVisitor(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockUpload(...args),
        info: (...args: unknown[]) => mockInfo(...args),
        getPublicUrl: () => ({
          data: { publicUrl: "https://storage.test/file" },
        }),
      }),
    },
  },
}));

import { POST } from "./route";

const source = {
  id: "source",
  workspace_id: "workspace",
  company_id: "company",
};
const ticket = {
  scope: "widget_upload",
  visitorId: "visitor",
  sourceId: "source",
  workspaceId: "workspace",
  companyId: "company",
  path: "web_widget/workspace/upload.png",
  bytes: 4,
  mimeType: "image/png",
  fileName: "image.png",
  reservationId: "reservation",
};
const request = (body: BodyInit, contentType?: string) =>
  new Request("http://localhost/api/widget/upload", {
    method: "POST",
    headers: {
      "x-client-key": "widget_client_key",
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body,
  }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockSource.mockResolvedValue({ ok: true, source });
  mockLimit.mockResolvedValue({ status: "granted" });
  mockReserve.mockResolvedValue({ _id: "reservation", status: "reserved" });
  mockRead.mockResolvedValue({
    _id: "reservation",
    ...ticket,
    companyId: "company",
    workspaceId: "workspace",
    provider: "supabase",
    bucket: "conversation-images",
    status: "reserved",
  });
  mockSign.mockResolvedValue("upload-ticket");
  mockVerify.mockResolvedValue(ticket);
  mockUpload.mockResolvedValue({ error: null });
  mockInfo.mockResolvedValue({
    data: { size: 4, contentType: "image/png" },
    error: null,
  });
});

it("reserves capacity and issues an upload-only ticket for a first media message", async () => {
  const response = await POST(
    request(
      JSON.stringify({
        action: "initiate",
        fileName: "image.png",
        mimeType: "image/png",
        fileSize: 4,
      }),
      "application/json"
    )
  );
  expect(response.status).toBe(200);
  expect(mockReserve).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace",
      bytes: 4,
      provider: "supabase",
    })
  );
  expect(mockSign).toHaveBeenCalledWith(
    expect.objectContaining({
      reservationId: "reservation",
      sourceId: "source",
    })
  );
  expect(mockUpload).not.toHaveBeenCalled();
});

it("fails closed before reservation when the distributed limiter is unavailable", async () => {
  mockLimit.mockResolvedValue({ status: "unavailable" });
  const response = await POST(
    request(
      JSON.stringify({ action: "initiate", fileSize: 4 }),
      "application/json"
    )
  );
  expect(response.status).toBe(503);
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
});

it("asks an outdated widget to refresh without accepting an unreserved upload", async () => {
  const form = new FormData();
  form.set("file", new File(["test"], "image.png", { type: "image/png" }));
  const response = await POST(request(form));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "Refresh this page before uploading a file.",
    code: "widget_upload_client_outdated",
  });
  expect(mockReserve).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
});

it("rejects a ticket from another source before writing bytes", async () => {
  mockVerify.mockResolvedValue({ ...ticket, sourceId: "other" });
  const form = new FormData();
  form.set("file", new File(["test"], "image.png", { type: "image/png" }));
  form.set("uploadToken", "ticket");
  const response = await POST(request(form));
  expect(response.status).toBe(403);
  expect(mockUpload).not.toHaveBeenCalled();
});

it("enforces the reserved byte count on the actual body", async () => {
  const form = new FormData();
  form.set("file", new File(["oversized"], "image.png", { type: "image/png" }));
  form.set("uploadToken", "ticket");
  const response = await POST(request(form));
  expect(response.status).toBe(400);
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockSettle).not.toHaveBeenCalled();
});

it("settles after the provider write and keeps an ambiguous failure charged", async () => {
  const form = new FormData();
  form.set("file", new File(["test"], "image.png", { type: "image/png" }));
  form.set("uploadToken", "ticket");
  mockUpload.mockResolvedValueOnce({ error: { message: "timeout" } });
  mockInfo.mockResolvedValueOnce({
    data: null,
    error: { message: "unavailable" },
  });
  const response = await POST(request(form));
  expect(response.status).toBe(503);
  expect(mockSettle).not.toHaveBeenCalled();
});

it("recovers a lost upload response using authoritative size and settles its original reservation", async () => {
  const form = new FormData();
  form.set("file", new File(["test"], "image.png", { type: "image/png" }));
  form.set("uploadToken", "ticket");
  mockUpload.mockResolvedValueOnce({ error: { message: "already exists" } });
  const response = await POST(request(form));
  expect(response.status).toBe(200);
  expect(mockSettle).toHaveBeenCalledWith("reservation", 4);
  expect(mockUpload).toHaveBeenCalledWith(
    ticket.path,
    expect.any(Buffer),
    expect.objectContaining({ upsert: false })
  );
});

it("a settled replay does not write another object", async () => {
  mockRead.mockResolvedValueOnce({
    ...ticket,
    companyId: "company",
    workspaceId: "workspace",
    provider: "supabase",
    bucket: "conversation-images",
    status: "stored",
  });
  const form = new FormData();
  form.set("file", new File(["test"], "image.png", { type: "image/png" }));
  form.set("uploadToken", "ticket");
  expect((await POST(request(form))).status).toBe(200);
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockSettle).not.toHaveBeenCalled();
});

it("a deleted reservation cannot be used by an outstanding widget ticket", async () => {
  mockRead.mockResolvedValueOnce({
    ...ticket,
    companyId: "company",
    workspaceId: "workspace",
    provider: "supabase",
    bucket: "conversation-images",
    status: "tombstoned",
  });
  const form = new FormData();
  form.set("file", new File(["test"], "image.png", { type: "image/png" }));
  form.set("uploadToken", "ticket");
  expect((await POST(request(form))).status).toBe(409);
  expect(mockUpload).not.toHaveBeenCalled();
});
