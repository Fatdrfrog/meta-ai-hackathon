/**
 * @jest-environment jsdom
 */

import {
  ATTACHMENT_UPLOAD_TIMEOUT_MS,
  AttachmentUploadTimeoutError,
  uploadAttachmentDirectly,
  uploadAttachmentThroughApi,
} from "./attachment-upload";

const mockUploadToSignedUrl = jest.fn();

jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        uploadToSignedUrl: (...args: unknown[]) =>
          mockUploadToSignedUrl(...args),
      }),
    },
  }),
}));

function makeFile(name = "photo.png"): File {
  return new File(["data"], name, { type: "image/png" });
}

describe("attachment upload timeout", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    mockUploadToSignedUrl.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  it("rejects with a timeout error when the API upload never settles", async () => {
    // A request that never resolves used to freeze the composer forever.
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as jest.Mock;

    const promise = uploadAttachmentThroughApi("conv-1", makeFile());
    const assertion = expect(promise).rejects.toBeInstanceOf(
      AttachmentUploadTimeoutError
    );

    await jest.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_TIMEOUT_MS);
    await assertion;
  });

  it("names the file in the timeout message", async () => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as jest.Mock;

    const promise = uploadAttachmentDirectly("conv-1", makeFile("invoice.pdf"));
    const assertion = expect(promise).rejects.toThrow("invoice.pdf");

    await jest.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_TIMEOUT_MS);
    await assertion;
  });

  it("times out the direct path when the storage upload hangs after a fast token response", async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              attachment: { mediaType: "image", mimeType: "image/png" },
              upload: { bucket: "b", path: "p", token: "t" },
            })
          ),
      } as unknown as Response)
    ) as jest.Mock;
    mockUploadToSignedUrl.mockReturnValue(new Promise(() => {}));

    const promise = uploadAttachmentDirectly("conv-1", makeFile());
    const assertion = expect(promise).rejects.toBeInstanceOf(
      AttachmentUploadTimeoutError
    );

    await jest.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_TIMEOUT_MS);
    await assertion;
  });

  it("resolves with the attachment when the API upload succeeds in time", async () => {
    const attachment = { mediaType: "image", mimeType: "image/png" };
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ attachment })),
      } as unknown as Response)
    ) as jest.Mock;

    await expect(
      uploadAttachmentThroughApi("conv-1", makeFile())
    ).resolves.toEqual(attachment);
  });
});
