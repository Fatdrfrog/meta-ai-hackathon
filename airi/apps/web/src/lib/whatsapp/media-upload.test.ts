const mockPostJson = jest.fn();
jest.mock("@icecore/shared/lib/meta/api", () => ({
  getWhatsAppGraphClient: () => ({
    postJson: (...args: unknown[]) => mockPostJson(...args),
  }),
}));
import {
  isWhatsAppTemplateMediaDownloadError,
  uploadWhatsAppMediaFromUrl,
} from "./media-upload";
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});
it("identifies expired media download responses before any provider upload or send", async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValue(new Response(null, { status: 403 }));
  const error = await uploadWhatsAppMediaFromUrl({
    phoneNumberId: "phone",
    accessToken: "secret",
    mediaUrl: "https://scontent.whatsapp.net/media?secret=private",
    kind: "video",
    fallbackMimeType: "video/mp4",
  }).catch(error => error);
  expect(isWhatsAppTemplateMediaDownloadError(error)).toBe(true);
  expect(error.status).toBe(403);
  expect(error.message).not.toContain("private");
  expect(mockPostJson).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledWith(expect.any(String), {
    signal: expect.any(AbortSignal),
  });
});
it("does not mistake provider or transport errors for expired media downloads", () => {
  expect(isWhatsAppTemplateMediaDownloadError(new Error("HTTP 403"))).toBe(
    false
  );
  expect(isWhatsAppTemplateMediaDownloadError({ status: 403 })).toBe(false);
});
it("bounds the media upload as well as its download below the shared lease", async () => {
  global.fetch = jest.fn().mockResolvedValue(
    new Response(new Uint8Array([1]), {
      headers: { "content-type": "video/mp4" },
    })
  );
  mockPostJson.mockResolvedValue({ id: "media" });
  await uploadWhatsAppMediaFromUrl({
    phoneNumberId: "phone",
    accessToken: "secret",
    mediaUrl: "https://scontent.whatsapp.net/media",
    kind: "video",
    fallbackMimeType: "video/mp4",
  });
  expect(mockPostJson).toHaveBeenCalledWith(
    "phone/media",
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  );
});
