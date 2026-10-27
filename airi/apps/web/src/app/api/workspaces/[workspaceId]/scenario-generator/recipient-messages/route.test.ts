const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/models/scenario-generated-recipient-message", () => ({
  ScenarioGeneratedRecipientMessage: {
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const messageId = "64f000000000000000000001";

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/workspaces/workspace-1/scenario-generator/recipient-messages",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function leanResult(value: unknown) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

describe("PATCH /api/workspaces/[workspaceId]/scenario-generator/recipient-messages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
  });

  it("edits a generated recipient message while it is still a draft", async () => {
    mockFindOneAndUpdate.mockReturnValue(
      leanResult({ _id: messageId, text: "Updated copy", sendStatus: "draft" })
    );

    const response = await PATCH(
      request({ scenarioId: "scenario-1", messageId, text: "Updated copy" }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: expect.anything(),
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        sendStatus: "draft",
      },
      {
        $set: {
          text: "Updated copy",
          updatedBy: "user-1",
        },
      },
      { new: true }
    );
  });

  it("returns a conflict instead of modifying a command-owned message", async () => {
    mockFindOneAndUpdate.mockReturnValue(leanResult(null));
    mockFindOne.mockReturnValue(
      leanResult({ _id: messageId, sendStatus: "preparing" })
    );

    const response = await PATCH(
      request({ scenarioId: "scenario-1", messageId, text: "Updated copy" }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error:
        "Message is already being prepared or dispatched and cannot be edited",
    });
    expect(mockFindOne).toHaveBeenCalledWith({
      _id: expect.anything(),
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
    });
  });
});

export {};
