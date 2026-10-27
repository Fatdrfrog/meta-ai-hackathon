const mockStore = jest.fn();
const mockPublicUrl = jest.fn();
jest.mock("@icecore/airi-runtime/storage-quota", () => ({
  storeSupabaseWorkspaceBuffer: (...args: unknown[]) => mockStore(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { storage: { from: () => ({ getPublicUrl: mockPublicUrl }) } },
}));
import {
  storeEmailInboundAttachment,
  resolveEmailInlineAttachments,
} from "./inbound-attachment";

describe("email inbound attachment quota", () => {
  it("keeps content IDs aligned when an earlier attachment is rejected", () => {
    expect(
      resolveEmailInlineAttachments(
        "cid:first cid:second",
        [{ ContentID: "<first>" }, { ContentID: "<second>" }],
        [
          null,
          {
            filename: "second",
            url: "https://storage/second",
            contentType: "image/png",
            sizeBytes: 5,
            storage_path: "second",
          },
        ]
      )
    ).toBe("cid:first https://storage/second");
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.mockResolvedValue(undefined);
    mockPublicUrl.mockReturnValue({
      data: { publicUrl: "https://storage/receipt" },
    });
  });
  it("accounts exact decoded bytes under the existing stable workspace path", async () => {
    const result = await storeEmailInboundAttachment("ws", "message", {
      Name: "receipt.txt",
      Content: Buffer.from("receipt").toString("base64"),
      ContentType: "text/plain",
      ContentLength: 1,
    });
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws",
        bucket: "email-attachments",
        path: "ws/message/receipt.txt",
        buffer: Buffer.from("receipt"),
      })
    );
    expect(result).toMatchObject({
      sizeBytes: 7,
      storage_path: "ws/message/receipt.txt",
    });
  });
  it("leaves the already captured inbound message unaffected on quota rejection", async () => {
    mockStore.mockRejectedValueOnce(new Error("storage_limit_exceeded"));
    await expect(
      storeEmailInboundAttachment("ws", "message", {
        Name: "receipt.txt",
        Content: "eA==",
      })
    ).resolves.toBeNull();
    expect(mockPublicUrl).not.toHaveBeenCalled();
  });
});
