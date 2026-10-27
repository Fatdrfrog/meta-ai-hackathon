const mockConnectDB = jest.fn();
const mockRequireScenarioWorkspaceAccess = jest.fn();
const mockScenarioFindOne = jest.fn();
const mockScenarioUpdateOne = jest.fn();
const mockCreateWhatsAppTemplateMutation = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));

jest.mock("@/lib/supabase/workspace-api-access", () => ({
  ...jest.requireActual("@/lib/supabase/workspace-api-access"),
  requireWorkspaceApiAccess: (...args: unknown[]) =>
    mockRequireScenarioWorkspaceAccess(...args),
}));

jest.mock("@/models/scenario", () => ({
  Scenario: {
    findOne: (...args: unknown[]) => mockScenarioFindOne(...args),
    updateOne: (...args: unknown[]) => mockScenarioUpdateOne(...args),
  },
}));

jest.mock("@/lib/whatsapp/templates/mutation-service", () => ({
  createWhatsAppTemplateMutation: (...args: unknown[]) =>
    mockCreateWhatsAppTemplateMutation(...args),
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/workspaces/workspace-1/scenario-generator/submit-template",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }
  );
}

function scenarioQuery<T>(value: T) {
  const query = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  query.select.mockReturnValue(query);
  return query;
}

describe("POST /api/workspaces/[workspaceId]/scenario-generator/submit-template", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireScenarioWorkspaceAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mockConnectDB.mockResolvedValue(undefined);
    mockScenarioUpdateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockCreateWhatsAppTemplateMutation.mockResolvedValue({
      id: "meta-template-1",
      status: "PENDING",
    });
  });

  it("submits generated templates through the shared mutation path", async () => {
    const scenarioId = "64f000000000000000000001";
    mockScenarioFindOne.mockReturnValue(
      scenarioQuery({
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        nodes: [
          {
            id: "node-1",
            data: {
              generatedTemplateDraft: {
                name: "generated_offer",
                language: "ru_RU",
                category: "MARKETING",
                components: [{ type: "BODY", text: "Hello *{{1}}*" }],
              },
            },
          },
        ],
      })
    );

    const response = await POST(
      request({
        scenarioId,
        nodeId: "node-1",
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        templateId: "meta-template-1",
        status: "pending",
        scenarioUpdate: expect.objectContaining({
          nodeId: "node-1",
          previousScenarioUpdatedAt: "2026-07-30T10:00:00.000Z",
          scenarioUpdatedAt: expect.any(String),
          patch: expect.objectContaining({
            actionWhatsAppTemplateId: "meta-template-1",
            actionWhatsAppTemplateCategory: "MARKETING",
          }),
        }),
      })
    );
    expect(mockCreateWhatsAppTemplateMutation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      userId: "user-1",
      name: "generated_offer",
      language: "ru_RU",
      category: "MARKETING",
      components: [{ type: "BODY", text: "Hello *{{1}}*" }],
      allowCategoryChange: true,
      analyticsOrigin: "scenario_generator",
    });
    expect(mockScenarioUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: scenarioId,
        workspaceId: "workspace-1",
        deletedAt: null,
        updatedAt: expect.any(Date),
      }),
      {
        $set: expect.objectContaining({
          graphSchemaVersion: 1,
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "node-1" }),
          ]),
          updatedBy: "user-1",
        }),
      },
      { timestamps: false }
    );
  });

  it("retries against the latest graph and preserves an unrelated concurrent edit", async () => {
    const scenarioId = "64f000000000000000000001";
    const initialRevision = new Date("2026-07-30T10:00:00.000Z");
    const concurrentRevision = new Date("2026-07-30T10:01:00.000Z");
    const initialScenario = {
      updatedAt: initialRevision,
      nodes: [
        {
          id: "node-1",
          data: {
            generatedTemplateDraft: {
              name: "generated_offer",
              language: "en",
              category: "MARKETING",
              components: [{ type: "BODY", text: "Initial" }],
            },
          },
        },
        {
          id: "node-2",
          data: { kind: "action", actionReplyText: "before" },
        },
      ],
      edges: [],
    };
    const concurrentScenario = {
      ...initialScenario,
      updatedAt: concurrentRevision,
      nodes: initialScenario.nodes.map(node =>
        node.id === "node-2"
          ? {
              ...node,
              data: {
                ...node.data,
                actionReplyText: "concurrent",
              },
            }
          : node
      ),
    };
    mockScenarioFindOne
      .mockReturnValueOnce(scenarioQuery(initialScenario))
      .mockReturnValueOnce(scenarioQuery(initialScenario))
      .mockReturnValueOnce(scenarioQuery(concurrentScenario));
    mockScenarioUpdateOne
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

    const response = await POST(request({ scenarioId, nodeId: "node-1" }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(200);
    expect(mockScenarioUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockScenarioUpdateOne.mock.calls[1]?.[0]).toEqual({
      _id: scenarioId,
      workspaceId: "workspace-1",
      deletedAt: null,
      status: "draft",
      updatedAt: concurrentRevision,
    });
    expect(mockScenarioUpdateOne.mock.calls[1]?.[1]?.$set?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "node-1",
          data: expect.objectContaining({
            actionWhatsAppTemplateId: "meta-template-1",
          }),
        }),
        expect.objectContaining({
          id: "node-2",
          data: expect.objectContaining({
            actionReplyText: "concurrent",
          }),
        }),
      ])
    );
  });

  it("fails safely when the submitted draft changed before the graph patch", async () => {
    const scenarioId = "64f000000000000000000001";
    const initialScenario = {
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      nodes: [
        {
          id: "node-1",
          data: {
            generatedTemplateDraft: {
              name: "generated_offer",
              language: "en",
              category: "MARKETING",
              components: [{ type: "BODY", text: "Initial" }],
            },
          },
        },
      ],
      edges: [],
    };
    const changedScenario = {
      ...initialScenario,
      updatedAt: new Date("2026-07-30T10:01:00.000Z"),
      nodes: [
        {
          id: "node-1",
          data: {
            generatedTemplateDraft: {
              name: "different_offer",
              language: "en",
              category: "MARKETING",
              components: [{ type: "BODY", text: "Changed" }],
            },
          },
        },
      ],
    };
    mockScenarioFindOne
      .mockReturnValueOnce(scenarioQuery(initialScenario))
      .mockReturnValueOnce(scenarioQuery(changedScenario));

    const response = await POST(request({ scenarioId, nodeId: "node-1" }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(409);
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("rejects when the selected template target changes after provider submission", async () => {
    const scenarioId = "64f000000000000000000001";
    const draft = {
      id: "draft-1",
      name: "generated_offer",
      language: "en",
      category: "MARKETING",
      status: "draft",
      components: [{ type: "BODY", text: "Initial" }],
    };
    const initialScenario = {
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      nodes: [
        {
          id: "node-1",
          data: {
            actionWhatsAppTemplateName: "selected-a",
            generatedTemplateDraft: draft,
          },
        },
      ],
      edges: [],
    };
    const changedScenario = {
      ...initialScenario,
      updatedAt: new Date("2026-07-30T10:01:00.000Z"),
      nodes: [
        {
          id: "node-1",
          data: {
            actionWhatsAppTemplateName: "selected-b",
            generatedTemplateDraft: draft,
          },
        },
      ],
    };
    mockScenarioFindOne
      .mockReturnValueOnce(scenarioQuery(initialScenario))
      .mockReturnValueOnce(scenarioQuery(changedScenario));

    const response = await POST(request({ scenarioId, nodeId: "node-1" }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });

    expect(response.status).toBe(409);
    expect(mockCreateWhatsAppTemplateMutation).toHaveBeenCalledTimes(1);
    expect(mockScenarioUpdateOne).not.toHaveBeenCalled();
  });

  it("returns the committed rejected draft patch and revisions", async () => {
    const scenarioId = "64f000000000000000000001";
    const scenario = {
      updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      nodes: [
        {
          id: "node-1",
          data: {
            generatedTemplateDraft: {
              id: "draft-1",
              name: "generated_offer",
              language: "en",
              status: "draft",
              components: [{ type: "BODY", text: "Initial" }],
            },
          },
        },
      ],
      edges: [],
    };
    mockScenarioFindOne.mockReturnValue(scenarioQuery(scenario));
    mockCreateWhatsAppTemplateMutation.mockRejectedValue(
      new Error("Meta rejected it")
    );

    const response = await POST(request({ scenarioId, nodeId: "node-1" }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: "Meta rejected it",
      scenarioUpdate: expect.objectContaining({
        nodeId: "node-1",
        previousScenarioUpdatedAt: "2026-07-30T10:00:00.000Z",
        scenarioUpdatedAt: expect.any(String),
        patch: {
          generatedTemplateDraft: expect.objectContaining({
            id: "draft-1",
            status: "rejected",
            error: "Meta rejected it",
          }),
        },
      }),
    });
  });

  it("rejects an old expected revision before calling Meta", async () => {
    const scenarioId = "64f000000000000000000001";
    mockScenarioFindOne.mockReturnValue(
      scenarioQuery({
        updatedAt: new Date("2026-07-30T10:01:00.000Z"),
        nodes: [],
      })
    );

    const response = await POST(
      request({
        scenarioId,
        nodeId: "node-1",
        expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(409);
    expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
  });

  it("rejects an invalid persisted revision before calling Meta", async () => {
    const scenarioId = "64f000000000000000000001";
    mockScenarioFindOne.mockReturnValue(
      scenarioQuery({ updatedAt: "invalid", nodes: [] })
    );

    const response = await POST(
      request({
        scenarioId,
        nodeId: "node-1",
        expectedUpdatedAt: "2026-07-30T10:00:00.000Z",
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );

    expect(response.status).toBe(409);
    expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
  });

  it("keeps each route on its reply button when the submitted template drops one", async () => {
    const scenarioId = "64f000000000000000000001";
    const draftComponents = [
      { type: "BODY", text: "Which plan?" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Basic" },
          { type: "QUICK_REPLY", text: "Premium" },
        ],
      },
    ];
    const submittedComponents = [
      { type: "BODY", text: "Which plan?" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Premium" }] },
    ];
    mockScenarioFindOne.mockReturnValue(
      scenarioQuery({
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        nodes: [
          {
            id: "node-1",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateComponents: draftComponents,
              generatedTemplateDraft: {
                id: "draft-1",
                name: "pick_plan",
                language: "en",
                category: "MARKETING",
                status: "draft",
                components: draftComponents,
              },
            },
          },
        ],
      })
    );

    const response = await POST(
      request({
        scenarioId,
        nodeId: "node-1",
        components: submittedComponents,
      }),
      { params: Promise.resolve({ workspaceId: "workspace-1" }) }
    );
    const body = await response.json();

    // Premium keeps the id of its old position, so its route stays on it.
    const buttonIds = {
      version: 1,
      nextId: 10,
      buttons: [{ id: 1, index: 0, text: "Premium" }],
    };
    expect(response.status).toBe(200);
    expect(body.scenarioUpdate.patch.actionWhatsAppTemplateButtonIds).toEqual(
      buttonIds
    );
    expect(mockScenarioUpdateOne.mock.calls[0]?.[1]?.$set?.nodes).toEqual([
      expect.objectContaining({
        id: "node-1",
        data: expect.objectContaining({
          actionWhatsAppTemplateComponents: submittedComponents,
          actionWhatsAppTemplateButtonIds: buttonIds,
        }),
      }),
    ]);
  });

  it("stores no button ids when the submitted template keeps its buttons in place", async () => {
    const scenarioId = "64f000000000000000000001";
    const components = [
      { type: "BODY", text: "Which plan?" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Basic" },
          { type: "QUICK_REPLY", text: "Premium" },
        ],
      },
    ];
    mockScenarioFindOne.mockReturnValue(
      scenarioQuery({
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        nodes: [
          {
            id: "node-1",
            data: {
              kind: "action",
              actionType: "whatsapp_template",
              actionWhatsAppTemplateComponents: components,
              generatedTemplateDraft: {
                id: "draft-1",
                name: "pick_plan",
                language: "en",
                status: "draft",
                components,
              },
            },
          },
        ],
      })
    );

    const response = await POST(request({ scenarioId, nodeId: "node-1" }), {
      params: Promise.resolve({ workspaceId: "workspace-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.scenarioUpdate.patch).not.toHaveProperty(
      "actionWhatsAppTemplateButtonIds"
    );
  });

  it.each(["submitting", "submitted", "pending", "approved"])(
    "does not resubmit a saved %s draft",
    async status => {
      const scenarioId = "64f000000000000000000001";
      mockScenarioFindOne.mockReturnValue(
        scenarioQuery({
          updatedAt: new Date("2026-07-30T10:00:00.000Z"),
          nodes: [
            {
              id: "node-1",
              data: {
                generatedTemplateDraft: {
                  id: "draft-1",
                  name: "generated_offer",
                  language: "en",
                  status,
                  components: [{ type: "BODY", text: "Hello" }],
                },
              },
            },
          ],
        })
      );

      const response = await POST(request({ scenarioId, nodeId: "node-1" }), {
        params: Promise.resolve({ workspaceId: "workspace-1" }),
      });

      expect(response.status).toBe(409);
      expect(mockCreateWhatsAppTemplateMutation).not.toHaveBeenCalled();
    }
  );
});

export {};
