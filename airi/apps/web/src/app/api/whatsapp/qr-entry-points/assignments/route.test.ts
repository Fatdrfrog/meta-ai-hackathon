const mockMembership = jest.fn();
const mockAssign = jest.fn();
const mockUnassign = jest.fn();
const mockRecover = jest.fn();
const mockProviderContext = jest.fn();

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockMembership(...args),
}));
jest.mock("@/lib/whatsapp/get-workspace-context", () => ({
  getWhatsAppWorkspaceContext: (...args: unknown[]) =>
    mockProviderContext(...args),
}));
jest.mock("@/lib/whatsapp/qr-entry-points/assignment", () => {
  const actual = jest.requireActual(
    "@/lib/whatsapp/qr-entry-points/assignment"
  );
  return {
    ...actual,
    assignWhatsAppQrEntryPoint: (...args: unknown[]) => mockAssign(...args),
    unassignWhatsAppQrEntryPoint: (...args: unknown[]) => mockUnassign(...args),
    recoverDetachedWhatsAppQrEntryPoint: (...args: unknown[]) =>
      mockRecover(...args),
  };
});

import { WhatsAppQrAssignmentError } from "@/lib/whatsapp/qr-entry-points/assignment";
import { POST } from "./route";

const ASSIGN_BODY = {
  command: "assign",
  workspaceId: "workspace-1",
  entryPointId: "entry-1",
  expectedEntryPointVersion: 3,
  target: {
    scenarioId: "scenario-2",
    nodeId: "node-2",
    expectedUpdatedAt: "2026-08-10T11:00:00.000Z",
    expectedCurrentEntryPointId: null,
  },
  acknowledgeMove: false,
  acknowledgeReplacement: false,
} as const;

function request(body: unknown) {
  return new Request(
    "http://localhost/api/whatsapp/qr-entry-points/assignments",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /api/whatsapp/qr-entry-points/assignments", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMembership.mockResolvedValue({
      membership: { role: "admin" },
      user: { id: "user-1" },
    });
    mockAssign.mockResolvedValue({
      entryPointId: "entry-1",
      entryPointVersion: 4,
      assignment: {
        scenarioId: "scenario-2",
        nodeId: "node-2",
        scenarioName: "Target",
        scenarioStatus: "draft",
        scenarioUpdatedAt: "2026-08-10T11:01:00.000Z",
      },
    });
  });

  it("authorizes with local Manager membership and returns only after commit", async () => {
    const response = await POST(request(ASSIGN_BODY));

    expect(response.status).toBe(200);
    expect(mockMembership).toHaveBeenCalledWith("workspace-1");
    expect(mockProviderContext).not.toHaveBeenCalled();
    expect(mockAssign).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      expectedEntryPointVersion: 3,
      target: ASSIGN_BODY.target,
      acknowledgeMove: false,
      acknowledgeReplacement: false,
    });
    await expect(response.json()).resolves.toMatchObject({
      entryPointVersion: 4,
      assignment: { scenarioId: "scenario-2" },
    });
  });

  it("rejects non-manager members without opening a local mutation", async () => {
    mockMembership.mockResolvedValueOnce({
      membership: { role: "member" },
      user: { id: "user-1" },
    });

    const response = await POST(request(ASSIGN_BODY));

    expect(response.status).toBe(403);
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockProviderContext).not.toHaveBeenCalled();
  });

  it("returns workspace-safe current assignment evidence on conflict", async () => {
    mockAssign.mockRejectedValueOnce(
      new WhatsAppQrAssignmentError(
        "VERSION_CONFLICT",
        "Target QR binding changed",
        {
          scenarioId: "scenario-2",
          nodeId: "node-2",
          scenarioName: "Target",
          scenarioStatus: "draft",
          scenarioUpdatedAt: "2026-08-10T11:01:00.000Z",
        }
      )
    );

    const response = await POST(request(ASSIGN_BODY));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "Target QR binding changed",
      code: "VERSION_CONFLICT",
      currentAssignment: {
        scenarioId: "scenario-2",
        nodeId: "node-2",
        scenarioName: "Target",
        scenarioStatus: "draft",
        scenarioUpdatedAt: "2026-08-10T11:01:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("workspace-2");
  });

  it("dispatches unassign and recover without provider credentials", async () => {
    mockUnassign.mockResolvedValueOnce({
      entryPointId: "entry-1",
      entryPointVersion: 5,
      assignment: null,
    });
    const unassign = await POST(
      request({
        command: "unassign",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        expectedEntryPointVersion: 4,
        sourceExpectedUpdatedAt: "2026-08-10T11:01:00.000Z",
      })
    );
    expect(unassign.status).toBe(200);
    expect(mockUnassign).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      expectedEntryPointVersion: 4,
      sourceExpectedUpdatedAt: "2026-08-10T11:01:00.000Z",
    });

    mockRecover.mockResolvedValueOnce({
      entryPointId: "entry-1",
      entryPointVersion: 6,
      assignment: null,
    });
    const recover = await POST(
      request({
        command: "recover",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        expectedEntryPointVersion: 5,
      })
    );
    expect(recover.status).toBe(200);
    expect(mockRecover).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      entryPointId: "entry-1",
      expectedEntryPointVersion: 5,
    });
    expect(mockProviderContext).not.toHaveBeenCalled();
  });

  it("strictly rejects provider fields on local assignment commands", async () => {
    const response = await POST(
      request({ ...ASSIGN_BODY, sourceId: "source-1", accessToken: "secret" })
    );

    expect(response.status).toBe(400);
    expect(mockMembership).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
  });
});
