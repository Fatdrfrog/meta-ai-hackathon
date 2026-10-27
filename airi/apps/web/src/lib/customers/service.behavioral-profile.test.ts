import mongoose from "mongoose";

const mockChat = jest.fn();
const mockGetHeavyTextModel = jest.fn(() => "claude-sonnet-5-5");
const mockCustomerFindById = jest.fn();
const mockCustomerUpdateOne = jest.fn();
const mockCustomerEventFindOneAndUpdate = jest.fn();
const mockMessageFind = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
}));

jest.mock("@/lib/ai", () => ({
  chatCompletionWithFallback: (...args: unknown[]) => mockChat(...args),
  getHeavyTextModel: () => mockGetHeavyTextModel(),
}));

jest.mock("@/models/conversation", () => ({ Conversation: {} }));

jest.mock("@/models/customer", () => ({
  __esModule: true,
  default: {
    findById: (...args: unknown[]) => mockCustomerFindById(...args),
    updateOne: (...args: unknown[]) => mockCustomerUpdateOne(...args),
  },
}));

jest.mock("@/models/customer-event", () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: (...args: unknown[]) =>
      mockCustomerEventFindOneAndUpdate(...args),
  },
}));

jest.mock("@/models/chat", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/user", () => ({ __esModule: true, default: {} }));

jest.mock("@/models/message", () => ({
  __esModule: true,
  default: { find: (...args: unknown[]) => mockMessageFind(...args) },
}));

import { generateBehavioralProfileForCustomer } from "@/lib/customers/service";

const customerId = new mongoose.Types.ObjectId("66b8db4b52ca2cbd68b79412");
const conversationId = new mongoose.Types.ObjectId("66b8db4b52ca2cbd68b79411");
const messageIds = Array.from(
  { length: 4 },
  (_, index) => new mongoose.Types.ObjectId(`66b8db4b52ca2cbd68b7950${index}`)
);

function messageQuery() {
  const messages = messageIds.map((id, index) => ({
    _id: id,
    conversation: conversationId,
    channel: "whatsapp",
    direction: index % 2 === 0 ? "inbound" : "outbound",
    text: `message ${index + 1}`,
    date: new Date(`2026-08-10T10:0${index}:00.000Z`),
  }));
  const query = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue([...messages].reverse()),
  };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

function savedProfile(): Record<string, unknown> {
  const update = mockCustomerUpdateOne.mock.calls.at(-1)?.[1] as {
    $set: { behavioralProfile: Record<string, unknown> };
  };
  return update.$set.behavioralProfile;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomerFindById.mockImplementation(() => ({
    lean: jest.fn().mockResolvedValue({
      _id: customerId,
      workspaceId: "ws-1",
      displayName: "Ada",
      conversationIds: [conversationId],
      behavioralProfile: null,
    }),
  }));
  mockCustomerUpdateOne.mockResolvedValue({ acknowledged: true });
  mockCustomerEventFindOneAndUpdate.mockResolvedValue({ _id: "event-1" });
  mockMessageFind.mockImplementation(messageQuery);
});

describe("generateBehavioralProfileForCustomer", () => {
  it("uses the heavy text tier and parses a fenced JSON reply", async () => {
    mockChat.mockResolvedValue({
      content: [
        "```json",
        JSON.stringify({
          summary: "Price-focused repeat buyer",
          communicationStyle: "Short and direct",
          motivations: ["fast delivery"],
          confidence: 0.7,
          evidenceRefs: ["M1", "M3"],
        }),
        "```",
      ].join("\n"),
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      latencyMs: 30,
    });

    await generateBehavioralProfileForCustomer({
      customerId: customerId.toString(),
      force: true,
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][0]).toMatchObject({
      model: "claude-sonnet-5-5",
      responseFormat: { type: "json_object" },
    });
    expect(savedProfile()).toMatchObject({
      status: "ready",
      summary: "Price-focused repeat buyer",
      communicationStyle: "Short and direct",
      motivations: ["fast delivery"],
      confidence: 0.7,
      model: "claude-sonnet-5-5",
      evidenceMessageIds: [messageIds[0], messageIds[2]],
      error: null,
    });
  });

  it("records the model that actually served the profile", async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ summary: "Asks about stock", confidence: 0.5 }),
      provider: "vertex",
      model: "gemini-3.5-flash",
      latencyMs: 30,
    });

    await generateBehavioralProfileForCustomer({
      customerId: customerId.toString(),
      force: true,
    });

    expect(savedProfile()).toMatchObject({
      status: "ready",
      model: "gemini-3.5-flash",
    });
  });

  it("marks the profile failed with the heavy tier model when generation fails", async () => {
    mockChat.mockRejectedValue(new Error("AI chat provider attempts failed"));

    await generateBehavioralProfileForCustomer({
      customerId: customerId.toString(),
      force: true,
    });

    expect(savedProfile()).toMatchObject({
      status: "failed",
      model: "claude-sonnet-5-5",
      error: "AI chat provider attempts failed",
    });
  });
});
