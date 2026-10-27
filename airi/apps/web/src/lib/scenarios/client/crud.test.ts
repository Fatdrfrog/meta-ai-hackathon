import type {
  ScenarioDocumentDTO,
  ScenarioCanvasNode,
  ScenarioGraphEdge,
} from "@icecore/scenario-contracts";
import {
  createScenarioRequest,
  fetchScenarioById,
  patchScenarioSidebarRequest,
  retryScenarioTimerReplanRecoveryRequest,
  updateScenarioRequest,
} from "./crud";
import {
  isBehindConfirmedScenarioRevision,
  readSettledScenarioWriteEpoch,
} from "./scenario-revision-tracker";

const originalFetch = global.fetch;

function scenarioDocument(): ScenarioDocumentDTO<
  ScenarioCanvasNode,
  ScenarioGraphEdge
> {
  return {
    _id: "scenario-1",
    name: "Scenario",
    description: "",
    status: "draft",
    mode: "conversation",
    timezone: "UTC",
    priority: 0,
    presetId: null,
    presetVersion: null,
    segmentKey: null,
    matchingRole: "default",
    entryPolicy: "repeatable",
    linkedParentScenarioIds: [],
    graphSchemaVersion: 1,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe("fetchScenarioById", () => {
  it.each([
    ["non-array nodes", { nodes: {} }],
    ["null node", { nodes: [null] }],
    ["missing node data", { nodes: [{ id: "action-1" }] }],
    ["null edge", { edges: [null] }],
    ["invalid viewport", { viewport: "invalid" }],
    ["zero zoom", { viewport: { x: 0, y: 0, zoom: 0 } }],
    ["missing identity", { _id: "" }],
  ])(
    "rejects a successful response with %s before editor projection",
    async (_name, patch) => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ scenario: { ...scenarioDocument(), ...patch } })
          )
        );
      await expect(
        fetchScenarioById({
          scenarioId: "scenario-1",
          workspaceId: "workspace-1",
        })
      ).rejects.toThrow("Invalid scenario payload");
    }
  );

  it("retains incomplete draft data and legacy canvas omissions", async () => {
    const scenario = {
      ...scenarioDocument(),
      nodes: [
        {
          id: "legacy",
          data: { kind: "trigger", triggerType: "exact_incoming_message" },
        },
        {
          id: "draft",
          data: {
            kind: "action",
            actionGenerativeAIConfig: {
              version: 1,
              mode: "text_to_image",
              prompt: "",
            },
          },
        },
      ],
      edges: [{ source: "legacy", target: "draft", extension: true }],
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ scenario })));
    const detail = await fetchScenarioById({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
    });
    expect(detail?.scenario).toEqual(scenario);
  });

  it("defaults absent legacy envelope metadata without rejecting an empty draft", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scenario: { _id: "legacy", name: "Legacy", nodes: [], edges: [] },
        })
      )
    );
    await expect(
      fetchScenarioById({ scenarioId: "legacy", workspaceId: "workspace-1" })
    ).resolves.toMatchObject({
      scenario: {
        nodes: [],
        edges: [],
        description: "",
        status: "draft",
        entryPolicy: "once_per_conversation",
        graphSchemaVersion: 0,
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: null,
        updatedAt: null,
      },
    });
  });

  it("keeps the existing failed-read message", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: "Hidden detail", code: "not_found" }),
          { status: 404 }
        )
      );
    await expect(
      fetchScenarioById({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    ).rejects.toThrow("Failed to load scenario");
  });

  it("asks for deferred media signing only when told to, and keeps the pending flag", async () => {
    const detail = {
      scenario: scenarioDocument(),
      metadata: {
        linkedConditionParentCountByNodeId: {},
        mediaDisplayUrlsPending: true,
      },
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      fetchScenarioById({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
        mediaSigning: "deferred",
      })
    ).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/scenarios/scenario-1?workspaceId=workspace-1&mediaSigning=deferred",
      expect.objectContaining({ cache: "no-store" })
    );

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...detail,
          metadata: { ...detail.metadata, mediaDisplayUrlsPending: "yes" },
        }),
        { status: 200 }
      )
    );
    const complete = await fetchScenarioById({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
    });
    expect(complete?.metadata).not.toHaveProperty("mediaDisplayUrlsPending");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/scenarios/scenario-1?workspaceId=workspace-1",
      expect.anything()
    );
  });

  it("preserves editor response metadata beside the canonical scenario", async () => {
    const detail = {
      scenario: scenarioDocument(),
      metadata: {
        linkedConditionParentCountByNodeId: {
          "trigger-1": 2,
        },
      },
    };
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(detail), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await expect(
      fetchScenarioById({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    ).resolves.toEqual(detail);
  });

  it("normalizes a committed timer-replan warning without discarding the saved scenario", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scenario: scenarioDocument(),
          metadata: {
            linkedConditionParentCountByNodeId: {},
            warnings: [
              {
                code: "legacy_action_routing_timer_replan_failed",
                message:
                  "Legacy routing committed, but a pending timer needs retry.",
                affectedConversationIds: ["conversation-1", "", 42],
              },
              { code: "unknown_warning", message: "ignore" },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    ) as typeof fetch;

    await expect(
      fetchScenarioById({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    ).resolves.toEqual({
      scenario: scenarioDocument(),
      metadata: {
        linkedConditionParentCountByNodeId: {},
        warnings: [
          {
            code: "legacy_action_routing_timer_replan_failed",
            message:
              "Legacy routing committed, but a pending timer needs retry.",
            affectedConversationIds: ["conversation-1"],
          },
        ],
      },
    });
  });

  it("preserves a committed session-cleanup warning with the saved scenario", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scenario: scenarioDocument(),
          metadata: {
            linkedConditionParentCountByNodeId: {},
            warnings: [
              {
                code: "legacy_action_routing_session_cleanup_failed",
                message:
                  "Legacy routing committed, but its database session cleanup failed.",
                affectedConversationIds: [],
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    ) as typeof fetch;

    await expect(
      fetchScenarioById({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    ).resolves.toEqual({
      scenario: scenarioDocument(),
      metadata: {
        linkedConditionParentCountByNodeId: {},
        warnings: [
          {
            code: "legacy_action_routing_session_cleanup_failed",
            message:
              "Legacy routing committed, but its database session cleanup failed.",
            affectedConversationIds: [],
          },
        ],
      },
    });
  });

  it("preserves persistent recovery status and all typed scenario warnings", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          scenario: scenarioDocument(),
          metadata: {
            linkedConditionParentCountByNodeId: {},
            warnings: [
              {
                code: "legacy_action_routing_timer_replan_failed",
                message: "Timer recovery remains queued.",
                affectedConversationIds: ["conversation-1"],
                recoveryStatus: "pending",
                retryable: true,
              },
              {
                code: "legacy_action_routing_session_cleanup_failed",
                message: "Session cleanup failed after commit.",
                affectedConversationIds: [],
              },
              {
                code: "linked_condition_reconciliation_pending",
                message: "Linked metadata is pending.",
                affectedScenarioIds: ["scenario-child"],
              },
              {
                code: "scenario_detail_enrichment_failed",
                message: "Scenario detail enrichment failed.",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as typeof fetch;

    await expect(
      fetchScenarioById({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    ).resolves.toMatchObject({
      metadata: {
        warnings: [
          expect.objectContaining({
            code: "legacy_action_routing_timer_replan_failed",
            recoveryStatus: "pending",
            retryable: true,
          }),
          {
            code: "legacy_action_routing_session_cleanup_failed",
            message: "Session cleanup failed after commit.",
            affectedConversationIds: [],
          },
          expect.objectContaining({
            code: "linked_condition_reconciliation_pending",
            affectedScenarioIds: ["scenario-child"],
          }),
          {
            code: "scenario_detail_enrichment_failed",
            message: "Scenario detail enrichment failed.",
          },
        ],
      },
    });
  });
});

describe("retryScenarioTimerReplanRecoveryRequest", () => {
  it("posts the exact scenario scope and returns persistent status", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          outstanding: {
            status: null,
            affectedConversationIds: [],
            hasMore: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as typeof fetch;

    await expect(
      retryScenarioTimerReplanRecoveryRequest({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
      })
    ).resolves.toMatchObject({ ok: true, outstanding: { status: null } });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/scenarios/scenario-1/timer-replan-recovery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      })
    );
  });
});

describe("createScenarioRequest", () => {
  it("sends once per conversation when entryPolicy is omitted", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ scenario: scenarioDocument() }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await createScenarioRequest({
      workspaceId: "workspace-1",
      name: "Scenario",
      description: "",
      status: "draft",
      priority: 0,
      matchingRole: "default",
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    const request = (global.fetch as jest.Mock).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    expect(JSON.parse(String(request?.body)).entryPolicy).toBe(
      "once_per_conversation"
    );
  });

  it("strips editor overlay fields from node data before POST", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ scenario: scenarioDocument() }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await createScenarioRequest({
      workspaceId: "workspace-1",
      name: "Scenario",
      description: "",
      status: "draft",
      priority: 0,
      matchingRole: "default",
      nodes: [
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyText: "Hello",
            uiNodeLabel: "Rendered label",
            uiOnPatch: () => undefined,
            actionPreviewText: "Rendered preview",
          },
        } as never,
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    const request = (global.fetch as jest.Mock).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const body = JSON.parse(String(request?.body)) as {
      nodes: Array<{ data: Record<string, unknown> }>;
    };
    expect(body.nodes[0]?.data).toEqual({
      kind: "action",
      actionType: "reply",
      actionReplyText: "Hello",
    });
  });
});

describe("updateScenarioRequest", () => {
  it("strips editor overlay fields from node data before PATCH", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ scenario: scenarioDocument() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await updateScenarioRequest({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
      name: "Scenario",
      description: "",
      status: "draft",
      priority: 0,
      matchingRole: "default",
      nodes: [
        {
          id: "action-1",
          data: {
            kind: "action",
            actionType: "reply",
            actionReplyText: "Hello",
            uiContextItems: [{ id: "snippet-1" }],
            compiledNodes: [],
            compiledEdges: [],
          },
        } as never,
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });

    const request = (global.fetch as jest.Mock).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    const body = JSON.parse(String(request?.body)) as {
      nodes: Array<{ data: Record<string, unknown> }>;
    };
    expect(body.nodes[0]?.data).toEqual({
      kind: "action",
      actionType: "reply",
      actionReplyText: "Hello",
    });
    expect(JSON.stringify(body.nodes[0]?.data)).not.toMatch(/"ui/);
  });
});

describe("scenario writes", () => {
  it("marks a save as a write in flight and remembers the revision it confirmed", async () => {
    let respond!: (response: Response) => void;
    global.fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          respond = resolve;
        })
    ) as typeof fetch;
    const saved = {
      ...scenarioDocument(),
      _id: "written-1",
      updatedAt: "2026-03-01T00:00:00.000Z",
    };

    const save = patchScenarioSidebarRequest({
      scenarioId: "written-1",
      workspaceId: "workspace-1",
      patch: { name: "Renamed" },
    });
    expect(readSettledScenarioWriteEpoch()).toBeNull();
    respond(new Response(JSON.stringify({ scenario: saved }), { status: 200 }));
    await save;

    expect(readSettledScenarioWriteEpoch()).not.toBeNull();
    expect(
      isBehindConfirmedScenarioRevision("written-1", "2026-02-01T00:00:00.000Z")
    ).toBe(true);
  });
});

describe("patchScenarioSidebarRequest", () => {
  it("preserves the server conflict code and message before document decoding", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Scenario changed",
          code: "scenario_updated_conflict",
          codes: ["scenario_updated_conflict"],
        }),
        { status: 409 }
      )
    );
    await expect(
      patchScenarioSidebarRequest({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
        patch: { status: "active" },
      })
    ).rejects.toMatchObject({
      name: "ScenarioRequestError",
      message: "Scenario changed",
      status: 409,
      code: "scenario_updated_conflict",
      codes: ["scenario_updated_conflict"],
    });
  });

  it("rejects a malformed successful PATCH response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ scenario: { ...scenarioDocument(), nodes: [null] } })
        )
      );
    await expect(
      patchScenarioSidebarRequest({
        scenarioId: "scenario-1",
        workspaceId: "workspace-1",
        patch: { status: "active" },
      })
    ).rejects.toThrow("Invalid scenario payload");
  });

  it("sends the canonical policy while omitting undefined sparse fields", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ scenario: scenarioDocument() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;

    await patchScenarioSidebarRequest({
      scenarioId: "scenario-1",
      workspaceId: "workspace-1",
      patch: {
        entryPolicy: "repeatable",
        status: undefined,
      },
    });

    const request = (global.fetch as jest.Mock).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    expect(JSON.parse(String(request?.body))).toEqual({
      workspaceId: "workspace-1",
      entryPolicy: "repeatable",
    });
  });
});
