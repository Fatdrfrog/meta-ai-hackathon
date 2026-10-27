const mockRecordScenarioLocationDecision = jest.fn();
const mockFindLatestInboundSharedLocation = jest.fn();
const mockLoadActiveBusinessLocations = jest.fn();
jest.mock("@/models/message", () => ({ __esModule: true, default: {} }));
jest.mock("@/models/scenario", () => ({ Scenario: {} }));
jest.mock("@/lib/temporal/airi-turn-execution", () => ({}));
jest.mock("./scenario-prompt-input-extraction", () => ({}));
jest.mock("./scenario-runtime", () => ({}));
jest.mock("./scenario-runtime-resources", () => ({}));
jest.mock("./generative-ai-customer-text-screen", () => ({}));
jest.mock("../reply/runtime/generative-ai-execution-store", () => ({}));
jest.mock("../reply/runtime/auto-reply-scenario-state", () => ({
  recordScenarioLocationDecisionAndPersist: (...args: unknown[]) =>
    mockRecordScenarioLocationDecision(...args),
}));
jest.mock("@/lib/business-locations/inbound-location-query", () => ({
  findLatestInboundSharedLocation: (...args: unknown[]) =>
    mockFindLatestInboundSharedLocation(...args),
}));
jest.mock("@/lib/business-locations/store", () => ({
  loadActiveBusinessLocations: (...args: unknown[]) =>
    mockLoadActiveBusinessLocations(...args),
}));

import { scenarioRuntimeDependencies } from "./auto-reply-runtime-dependencies";

// Without these ports the runtime turns location routes off, so the web
// adapter the worker uses must always wire them.
describe("location route ports of the reply runtime", () => {
  beforeEach(() => jest.clearAllMocks());

  it("records decisions through the fenced scenario state write", async () => {
    const input = { conversationId: "conversation-1" } as never;
    mockRecordScenarioLocationDecision.mockResolvedValue({
      persisted: true,
      state: {},
    });

    await expect(
      scenarioRuntimeDependencies.recordScenarioLocationDecision?.(input)
    ).resolves.toEqual({ persisted: true, state: {} });
    expect(mockRecordScenarioLocationDecision).toHaveBeenCalledWith(input);
  });

  it("looks up shares left behind through the inbound location query", async () => {
    const scope = {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      since: new Date("2026-10-05T10:00:00.000Z"),
      until: new Date("2026-10-05T10:05:00.000Z"),
      excludeMessageIds: [],
    };
    mockFindLatestInboundSharedLocation.mockResolvedValue(null);

    await expect(
      scenarioRuntimeDependencies.findLatestInboundLocation?.(scope)
    ).resolves.toBeNull();
    expect(mockFindLatestInboundSharedLocation).toHaveBeenCalledWith(scope);
  });

  it("reads the workspace's active offices", async () => {
    const office = {
      key: "almaty_abay",
      name: "Abay",
      country: "KZ",
      city: "Almaty",
      cityKey: "almaty",
      tags: [],
      latitude: 43.24,
      longitude: 76.91,
      sortOrder: 0,
    };
    mockLoadActiveBusinessLocations.mockResolvedValue([office]);

    await expect(
      scenarioRuntimeDependencies.loadBusinessLocations?.({
        workspaceId: "workspace-1",
      })
    ).resolves.toEqual([office]);
    expect(mockLoadActiveBusinessLocations).toHaveBeenCalledWith("workspace-1");
  });
});
