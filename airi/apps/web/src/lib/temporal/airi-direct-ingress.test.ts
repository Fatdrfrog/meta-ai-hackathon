const mockPersist = jest.fn();
const mockDispatch = jest.fn();
jest.mock("./client", () => ({ isTemporalConfigured: () => true }));
jest.mock("./airi-turn-context", () => ({
  buildAiriConversationIngressKey: () => "ingress-key",
  createAiriConversationTurnContext: (...args: unknown[]) =>
    mockPersist(...args),
}));
jest.mock("./airi-conversation-ingress", () => ({
  dispatchPersistedAiriConversationIngress: (...args: unknown[]) =>
    mockDispatch(...args),
}));
import { enqueueAiriConversationIngress } from "./airi-direct-ingress";

describe("durable optional Airi handoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPersist.mockResolvedValue({ ingressKey: "ingress-key" });
  });
  it("returns after persistence without awaiting or starting optional dispatch", async () => {
    const tasks: Array<() => Promise<void>> = [];
    await enqueueAiriConversationIngress({} as never, task => {
      tasks.push(task);
      return true;
    });
    expect(mockPersist).toHaveBeenCalledWith({}, { ingressKey: "ingress-key" });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await tasks[0]();
    expect(mockDispatch).toHaveBeenCalledWith({ ingressKey: "ingress-key" });
  });
  it("leaves accepted work durable when acceleration is full or fails", async () => {
    await expect(
      enqueueAiriConversationIngress({} as never, () => false)
    ).resolves.toEqual({});
    const tasks: Array<() => Promise<void>> = [];
    mockDispatch.mockRejectedValueOnce(new Error("Temporal offline"));
    await enqueueAiriConversationIngress({} as never, task => {
      tasks.push(task);
      return true;
    });
    await expect(tasks[0]()).rejects.toThrow("Temporal offline");
    expect(mockPersist).toHaveBeenCalledTimes(2);
  });
  it("never schedules work or acknowledges failed durable persistence", async () => {
    const schedule = jest.fn();
    mockPersist.mockRejectedValueOnce(new Error("mongo offline"));
    await expect(
      enqueueAiriConversationIngress({} as never, schedule)
    ).rejects.toThrow("mongo offline");
    expect(schedule).not.toHaveBeenCalled();
  });
});
