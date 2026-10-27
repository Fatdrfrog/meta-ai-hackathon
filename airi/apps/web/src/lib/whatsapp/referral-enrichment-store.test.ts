jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock("@/lib/crypto", () => ({
  decryptMaybeString: (value: unknown) => value,
}));
const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockConversationFind = jest.fn();
const mockConversationUpdate = jest.fn();
const mockEnrich = jest.fn();
jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("@/models/message", () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => ({ lean: async () => mockFind(...a) }),
    updateOne: (...a: unknown[]) => mockUpdate(...a),
  },
}));
jest.mock("@/models/conversation", () => ({
  Conversation: {
    findById: (...a: unknown[]) => ({
      select: () => ({ lean: async () => mockConversationFind(...a) }),
    }),
    findOneAndUpdate: (...a: unknown[]) => mockConversationUpdate(...a),
  },
}));
jest.mock("./referral-enrichment", () => ({
  ...jest.requireActual("./referral-enrichment"),
  enrichWhatsAppReferralWithMetaAdMetadata: (...a: unknown[]) =>
    mockEnrich(...a),
  buildWhatsAppReferralRagContext: (r: { campaignName?: string }) =>
    r.campaignName ? `referral: ${r.campaignName}` : "referral: raw",
}));
import { enrichStoredWhatsAppReferral } from "./referral-enrichment-store";
const input = {
  workspaceId: "workspace",
  conversationId: "conversation",
  messageId: "message",
};
const raw = { sourceId: "ad", sourceType: "ad" };
describe("recoverable referral enrichment", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFind.mockReturnValue({
      _id: "message",
      workspaceId: "workspace",
      conversation: "conversation",
      date: new Date(0),
      whatsappReferral: raw,
      ragContext: "referral: raw\ncommerce",
    });
    mockEnrich.mockResolvedValue({
      ...raw,
      campaignName: "campaign",
      campaignLabelStatus: "absent",
    });
    mockUpdate.mockResolvedValue({ matchedCount: 1 });
    mockConversationFind.mockReturnValue({ whatsappReferral: raw });
    mockConversationUpdate.mockResolvedValue({
      _id: "conversation",
      workspaceId: "workspace",
    });
  });
  it("does no enrichment or conversation writes without a referral", async () => {
    mockFind.mockReturnValue({ date: new Date(0) });
    await enrichStoredWhatsAppReferral(input);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
  });
  it("leaves the stored all-null referral default untouched", async () => {
    mockFind.mockReturnValue({
      date: new Date(0),
      whatsappReferral: {
        sourceType: null,
        sourceId: null,
        ctwaClid: null,
        capturedAt: null,
      },
      ragContext: null,
    });
    await enrichStoredWhatsAppReferral(input);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockConversationFind).not.toHaveBeenCalled();
  });
  it("fences tenant ownership and repairs the conversation after a prior partial write", async () => {
    await enrichStoredWhatsAppReferral(input);
    expect(mockFind).toHaveBeenCalledWith({
      _id: "message",
      workspaceId: "workspace",
      conversation: "conversation",
      direction: "inbound",
      channel: "whatsapp",
    });
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappReferral: raw }),
      {
        $set: expect.objectContaining({
          ragContext: "referral: campaign\ncommerce",
        }),
      }
    );
    mockConversationUpdate.mockRejectedValueOnce(
      new Error("mongo interruption")
    );
    await expect(enrichStoredWhatsAppReferral(input)).rejects.toThrow(
      "mongo interruption"
    );
    await expect(enrichStoredWhatsAppReferral(input)).resolves.toBeUndefined();
  });
  it("does not lose concurrent edits and retries a failed CAS", async () => {
    mockUpdate.mockResolvedValueOnce({ matchedCount: 0 });
    await enrichStoredWhatsAppReferral(input);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdate.mock.calls[0][0]).toMatchObject({
      ragContext: "referral: raw\ncommerce",
    });
  });
  it("keeps failed metadata work retryable while recording unavailable metadata", async () => {
    mockEnrich.mockResolvedValue({
      ...raw,
      campaignLabelStatus: "unavailable",
    });
    await expect(enrichStoredWhatsAppReferral(input)).rejects.toThrow(
      "unavailable"
    );
    expect(mockUpdate).toHaveBeenCalled();
  });
});
