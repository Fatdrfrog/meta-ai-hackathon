import { cache } from "@icecore/shared/lib/cache";
import { uploadWhatsAppMediaFromUrl } from "@/lib/whatsapp/media-upload";
import {
  normalizeWhatsAppTemplateHeaderMediaComponents,
  type WhatsAppHeaderMediaUploadCache,
} from "./header-media";
import type { WhatsAppTemplateSendComponentInput } from "./message-types";

jest.mock("@icecore/shared/lib/cache", () => ({
  buildCacheKey: jest.requireActual("@icecore/shared/lib/cache").buildCacheKey,
  cache: {
    readWithStatus: jest.fn(),
    acquireLock: jest.fn(),
    publishIfLockOwned: jest.fn(),
    compareAndDelete: jest.fn(),
  },
}));
jest.mock("@/lib/whatsapp/media-upload", () => ({
  uploadWhatsAppMediaFromUrl: jest.fn(),
}));

const mockCache = jest.mocked(cache);
const mockUpload = jest.mocked(uploadWhatsAppMediaFromUrl);
const records = new Map<string, unknown>();
const locks = new Map<string, string>();
const sampleUrl = "https://mmg.whatsapp.net/header.jpg?signature=private";

function components(
  link = sampleUrl,
  kind: "image" | "video" | "document" = "image",
  filename?: string
): WhatsAppTemplateSendComponentInput[] {
  const parameter =
    kind === "document"
      ? { type: kind, document: { link, filename } }
      : kind === "video"
        ? { type: kind, video: { link } }
        : { type: kind, image: { link } };
  return [{ type: "header", parameters: [parameter] }];
}

function normalize(
  options: {
    phoneNumberId?: string;
    link?: string;
    kind?: "image" | "video" | "document";
    filename?: string;
    cache?: WhatsAppHeaderMediaUploadCache;
  } = {}
) {
  return normalizeWhatsAppTemplateHeaderMediaComponents({
    components: components(options.link, options.kind, options.filename),
    phoneNumberId: options.phoneNumberId ?? "phone-a",
    accessToken: "secret-token",
    cache: options.cache,
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  records.clear();
  locks.clear();
  mockCache.readWithStatus.mockImplementation(async key =>
    records.has(key)
      ? { status: "hit", value: records.get(key) }
      : { status: "miss" }
  );
  mockCache.acquireLock.mockImplementation(async (key, token) => {
    if (locks.has(key)) return "contended";
    locks.set(key, token as string);
    return "acquired";
  });
  mockCache.publishIfLockOwned.mockImplementation(async input => {
    if (locks.get(input.lockKey) !== input.ownerToken) return "lost";
    records.set(input.valueKey, input.value);
    locks.delete(input.lockKey);
    return "published";
  });
  mockCache.compareAndDelete.mockImplementation(async (key, token) => {
    if (locks.get(key) !== token) return false;
    locks.delete(key);
    return true;
  });
  mockUpload.mockImplementation(async () => ({
    id: `media-${mockUpload.mock.calls.length}`,
    mimeType: "image/jpeg",
    sizeBytes: 12,
  }));
});

afterEach(() => jest.useRealTimers());

it("reuses an uploaded ID across separate sends for 24 hours without caching secrets", async () => {
  const first = await normalize();
  expect(await normalize()).toEqual(first);
  expect(mockUpload).toHaveBeenCalledTimes(1);
  expect(mockCache.publishIfLockOwned).toHaveBeenCalledWith(
    expect.objectContaining({ ttlSeconds: 24 * 60 * 60 })
  );
  const serialized = JSON.stringify([...records]);
  expect(serialized).not.toContain(sampleUrl);
  expect(serialized).not.toContain("secret-token");
  expect(serialized).not.toContain("signature");
});

it("keeps IDs isolated by phone, media kind, exact signed URL and document filename", async () => {
  const local: WhatsAppHeaderMediaUploadCache = new Map();
  await normalize({ cache: local });
  await normalize({ cache: local, phoneNumberId: "phone-b" });
  await normalize({ cache: local, kind: "video" });
  await normalize({ cache: local, link: `${sampleUrl}-new` });
  await normalize({ cache: local, kind: "document", filename: "one.pdf" });
  await normalize({ cache: local, kind: "document", filename: "two.pdf" });
  expect(mockUpload).toHaveBeenCalledTimes(6);
  expect(records.size).toBe(6);
});

it("refreshes an expired ID even when the caller reuses its local promise cache", async () => {
  jest.useFakeTimers();
  const local: WhatsAppHeaderMediaUploadCache = new Map();
  const first = await normalize({ cache: local });
  jest.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
  expect(await normalize({ cache: local })).not.toEqual(first);
  expect(mockUpload).toHaveBeenCalledTimes(2);
});

it("shares a completed upload with a concurrent send using another request cache", async () => {
  jest.useFakeTimers();
  let resolveUpload!: (
    value: Awaited<ReturnType<typeof uploadWhatsAppMediaFromUrl>>
  ) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  mockUpload.mockImplementationOnce(() => {
    markStarted();
    return new Promise(resolve => {
      resolveUpload = resolve;
    });
  });
  const first = normalize();
  await started;
  const second = normalize();
  await jest.advanceTimersByTimeAsync(0);
  resolveUpload({ id: "shared-media", mimeType: "image/jpeg", sizeBytes: 12 });
  const result = await first;
  await jest.advanceTimersByTimeAsync(250);
  expect(await second).toEqual(result);
  expect(mockUpload).toHaveBeenCalledTimes(1);
});

it("fails closed when the shared cache cannot be read", async () => {
  mockCache.readWithStatus.mockResolvedValue({ status: "unavailable" });
  await expect(normalize()).rejects.toThrow(/temporarily unavailable/i);
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockCache.acquireLock).not.toHaveBeenCalled();
});

it("fails closed when a distributed lock cannot be acquired", async () => {
  mockCache.acquireLock.mockResolvedValue("unavailable");
  await expect(normalize()).rejects.toThrow(/temporarily unavailable/i);
  expect(mockUpload).not.toHaveBeenCalled();
});

it("bounds contention rather than starting another upload", async () => {
  jest.useFakeTimers();
  mockCache.acquireLock.mockResolvedValue("contended");
  const failed = normalize().catch(error => error);
  await jest.advanceTimersByTimeAsync(2_000);
  expect(await failed).toEqual(
    expect.objectContaining({ message: expect.stringMatching(/in progress/i) })
  );
  expect(mockUpload).not.toHaveBeenCalled();
});

it("does not use an uploaded ID when ownership was lost before publication", async () => {
  mockCache.publishIfLockOwned.mockResolvedValue("lost");
  await expect(normalize()).rejects.toThrow(/temporarily unavailable/i);
  expect(records.size).toBe(0);
});

it("retains the lease when publication fails so other requests cannot immediately reupload", async () => {
  mockCache.publishIfLockOwned.mockResolvedValue("unavailable");
  await expect(normalize()).rejects.toThrow(/temporarily unavailable/i);
  expect(mockCache.compareAndDelete).not.toHaveBeenCalled();
  expect(locks.size).toBe(1);
});

it("evicts a failed local upload promise so a retry can succeed", async () => {
  const local: WhatsAppHeaderMediaUploadCache = new Map();
  mockUpload.mockRejectedValueOnce(new Error("HTTP 403"));
  await expect(normalize({ cache: local })).rejects.toThrow("HTTP 403");
  await expect(normalize({ cache: local })).resolves.toEqual([
    {
      type: "header",
      parameters: [{ type: "image", image: { id: "media-2" } }],
    },
  ]);
  expect(mockUpload).toHaveBeenCalledTimes(2);
});

it("preserves owned external URLs and existing IDs without depending on the cache", async () => {
  const input: WhatsAppTemplateSendComponentInput[] = [
    ...components("https://storage.example.org/owned.jpg"),
    {
      type: "header",
      parameters: [{ type: "image", image: { id: "existing-id" } }],
    },
  ];
  expect(
    await normalizeWhatsAppTemplateHeaderMediaComponents({
      components: input,
      phoneNumberId: "phone-a",
      accessToken: "secret-token",
    })
  ).toBe(input);
  expect(mockCache.readWithStatus).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
});
