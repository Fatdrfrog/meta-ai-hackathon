import {
  attachWhatsAppFlowProviderReference,
  createWhatsAppFlow,
  deleteWhatsAppFlow,
  fetchTemplateFlowFacts,
  fetchWhatsAppFlowsList,
  parseWhatsAppFlowActionPayload,
  provisionWhatsAppFlow,
  sendWhatsAppFlowTest,
  updateWhatsAppFlow,
} from "./client";

const PROVISION_PARAMS = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  scenarioId: "scenario-1",
  nodeId: "node-1",
  editableConfig: {
    templateId: "appointment_booking",
    ctaText: "Book",
    flowNavigationMode: "data_endpoint" as const,
    screens: [{ id: "DETAILS", title: "Details", fields: [] }],
  },
};

const PROVIDER_REFERENCE_PARAMS = {
  workspaceId: "workspace-1",
  sourceId: "source-1",
  scenarioId: "scenario-1",
  nodeId: "node-1",
  flowId: "flow-1",
  expectedUpdatedAt: "2026-08-05T10:00:00.000Z",
};

describe("WhatsApp flows client", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("attaches an existing Flow through the server-authorized reference endpoint", async () => {
    const payload = {
      ok: true,
      flowConfig: {
        templateId: "provider_reference",
        screens: [{ id: "APPOINTMENT", title: "Appointment", fields: [] }],
        ctaText: "Open",
        providerReference: {
          flowId: "flow-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          providerStatus: "PUBLISHED",
        },
      },
      previousScenarioUpdatedAt: "2026-08-05T10:00:00.000Z",
      scenarioUpdatedAt: "2026-08-05T10:00:01.000Z",
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json(payload));

    const result = await attachWhatsAppFlowProviderReference(
      PROVIDER_REFERENCE_PARAMS
    );

    expect(result).toEqual({ ok: true, status: 200, data: payload });
    expect(global.fetch).toHaveBeenCalledWith("/api/whatsapp/flows/reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PROVIDER_REFERENCE_PARAMS),
    });
  });

  it("caches list reads and invalidates them after a mutation", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        Response.json({
          flows: [{ id: "flow-1", name: "First" }],
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          flow: { id: "flow-2" },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          flows: [{ id: "flow-2", name: "Second" }],
        })
      );

    const first = await fetchWhatsAppFlowsList({
      workspaceId: "workspace-cache-mutation",
      sourceId: "source-cache",
    });
    const cached = await fetchWhatsAppFlowsList({
      workspaceId: "workspace-cache-mutation",
      sourceId: "source-cache",
    });
    const createResult = await createWhatsAppFlow({
      workspaceId: "workspace-cache-mutation",
      sourceId: "source-cache",
      name: "Second",
      categories: ["OTHER"],
    });
    const refreshed = await fetchWhatsAppFlowsList({
      workspaceId: "workspace-cache-mutation",
      sourceId: "source-cache",
    });

    expect(first.data?.flows?.[0]?.id).toBe("flow-1");
    expect(cached.data?.flows?.[0]?.id).toBe("flow-1");
    expect(createResult.ok).toBe(true);
    expect(refreshed.data?.flows?.[0]?.id).toBe("flow-2");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("isolates list caches and invalidation by exact WhatsApp source", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-source-1" }] })
      )
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-source-2" }] })
      )
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-source-1-refreshed" }] })
      );

    await fetchWhatsAppFlowsList({
      workspaceId: "workspace-source-cache",
      sourceId: "source-1",
    });
    await fetchWhatsAppFlowsList({
      workspaceId: "workspace-source-cache",
      sourceId: "source-2",
    });
    await updateWhatsAppFlow({
      workspaceId: "workspace-source-cache",
      sourceId: "source-1",
      flowId: "flow-source-1",
      operation: "publish",
    });
    const sourceTwoCached = await fetchWhatsAppFlowsList({
      workspaceId: "workspace-source-cache",
      sourceId: "source-2",
    });
    const sourceOneRefreshed = await fetchWhatsAppFlowsList({
      workspaceId: "workspace-source-cache",
      sourceId: "source-1",
    });

    expect(sourceTwoCached.data?.flows?.[0]?.id).toBe("flow-source-2");
    expect(sourceOneRefreshed.data?.flows?.[0]?.id).toBe(
      "flow-source-1-refreshed"
    );
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/whatsapp/flows?workspaceId=workspace-source-cache&limit=200&sourceId=source-1",
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/whatsapp/flows?workspaceId=workspace-source-cache&limit=200&sourceId=source-2",
      expect.any(Object)
    );
  });

  it("uses the single managed provisioning boundary and invalidates Flow lists on success", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      Response.json({
        ok: true,
        operationId: "operation-1",
        status: "COMPLETED",
        stage: "COMPLETED",
        projection: {
          operationId: "operation-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          contentDigest: "a".repeat(64),
          flowId: "flow-1",
          providerStatus: "PUBLISHED",
        },
        scenarioRevision: {
          finalUpdatedAt: "2026-08-08T10:00:01.000Z",
        },
        phones: [],
        validationErrors: [],
      })
    );
    const result = await provisionWhatsAppFlow(PROVISION_PARAMS);

    expect(result).toMatchObject({
      ok: true,
      data: { projection: { providerStatus: "PUBLISHED" } },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/flows/provision",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(PROVISION_PARAMS),
      })
    );
  });

  it.each([
    {
      status: 400,
      body: { error: "Malformed request" },
      code: "WHATSAPP_FLOW_PROVISIONING_INVALID_INPUT",
      message: "Malformed request",
    },
    {
      status: 401,
      body: { error: { message: "Sign in required" } },
      code: "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED",
      message: "Sign in required",
    },
    {
      status: 403,
      body: { error: "Manager access required" },
      code: "WHATSAPP_FLOW_PROVISIONING_ACCESS_DENIED",
      message: "Manager access required",
    },
    {
      status: 409,
      body: {
        ok: false,
        error: {
          code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_BINDING_CHANGED",
          message: "Refresh and retry",
        },
      },
      code: "WHATSAPP_FLOW_PROVISIONING_SOURCE_BINDING_CHANGED",
      message: "Refresh and retry",
    },
    {
      status: 500,
      body: null,
      code: "WHATSAPP_FLOW_PROVISIONING_FAILED",
      message: "WhatsApp Flow provisioning failed",
    },
  ])(
    "normalizes an HTTP $status response into a UI-safe failure",
    async ({ status, body, code, message }) => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        Response.json(body, { status })
      );

      const result = await provisionWhatsAppFlow(PROVISION_PARAMS);

      expect(result).toEqual({
        ok: false,
        status,
        data: {
          ok: false,
          stage: "VALIDATING",
          phones: [],
          validationErrors: [],
          error: {
            code,
            message,
            retryable: status >= 500,
          },
        },
      });
    }
  );

  it("normalizes network failures instead of rejecting the UI save handler", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("offline"));

    const result = await provisionWhatsAppFlow(PROVISION_PARAMS);

    expect(result).toEqual({
      ok: false,
      status: 0,
      data: {
        ok: false,
        stage: "VALIDATING",
        phones: [],
        validationErrors: [],
        error: {
          code: "WHATSAPP_FLOW_PROVISIONING_FAILED",
          message: "offline",
          retryable: true,
        },
      },
    });
  });

  it("drops malformed issue and phone entries before the result reaches the UI", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          stage: "READING_BACK",
          phones: [null, "phone"],
          validationErrors: [null, { message: "Bad field", path: "screens.0" }],
          error: {
            code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
            message: "Not published",
            retryable: true,
          },
        },
        { status: 409 }
      )
    );

    const result = await provisionWhatsAppFlow(PROVISION_PARAMS);

    expect(result.data).toMatchObject({
      ok: false,
      phones: [],
      validationErrors: [{ message: "Bad field", path: "screens.0" }],
    });
  });

  it("invalidates a cached Flow list after a persisted BLOCKED reconciliation", async () => {
    const params = {
      ...PROVISION_PARAMS,
      workspaceId: "workspace-blocked-reconciliation",
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-1", status: "PUBLISHED" }] })
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            operationId: "operation-1",
            status: "COMPLETED",
            stage: "READING_BACK",
            projection: {
              operationId: "operation-1",
              sourceId: "source-1",
              wabaId: "waba-1",
              contentRevision: 1,
              contentDigest: "a".repeat(64),
              flowId: "flow-1",
              providerStatus: "BLOCKED",
            },
            scenarioRevision: {
              finalUpdatedAt: "2026-08-08T10:00:01.000Z",
            },
            phones: [],
            validationErrors: [],
            error: {
              code: "WHATSAPP_FLOW_PROVISIONING_READBACK_NOT_PUBLISHED",
              message: "Meta reports BLOCKED",
              retryable: true,
            },
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-1", status: "BLOCKED" }] })
      );

    await fetchWhatsAppFlowsList({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
    });
    const provisioned = await provisionWhatsAppFlow(params);
    const refreshed = await fetchWhatsAppFlowsList({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
    });

    expect(provisioned.data).toMatchObject({
      ok: false,
      projection: { providerStatus: "BLOCKED" },
    });
    expect(refreshed.data?.flows?.[0]?.status).toBe("BLOCKED");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("invalidates a cached Flow list after a provider-side failure without a scenario projection", async () => {
    const params = {
      ...PROVISION_PARAMS,
      workspaceId: "workspace-provider-draft-failure",
    };
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-old", status: "PUBLISHED" }] })
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            operationId: "operation-draft",
            status: "FAILED",
            stage: "UPLOADING_JSON",
            phones: [],
            validationErrors: [],
            error: {
              code: "WHATSAPP_FLOW_PROVISIONING_JSON_INVALID",
              message: "Meta retained the draft",
              retryable: false,
            },
          },
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-draft", status: "DRAFT" }] })
      );

    await fetchWhatsAppFlowsList({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
    });
    const provisioned = await provisionWhatsAppFlow(params);
    const refreshed = await fetchWhatsAppFlowsList({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
    });

    expect(provisioned.data).toMatchObject({
      ok: false,
      operationId: "operation-draft",
    });
    expect(refreshed.data?.flows?.[0]?.id).toBe("flow-draft");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not let stale in-flight list reads repopulate cache after invalidation", async () => {
    let resolveList: (value: Response) => void = () => undefined;
    const staleListResponse = new Promise<Response>(resolve => {
      resolveList = resolve;
    });

    (global.fetch as jest.Mock)
      .mockReturnValueOnce(staleListResponse)
      .mockResolvedValueOnce(
        Response.json({ success: true, flow: { id: "created-flow" } })
      )
      .mockResolvedValueOnce(
        Response.json({
          flows: [{ id: "fresh-flow", name: "Fresh" }],
        })
      );

    const staleRead = fetchWhatsAppFlowsList({
      workspaceId: "workspace-stale-inflight",
      sourceId: "source-stale",
    });

    await createWhatsAppFlow({
      workspaceId: "workspace-stale-inflight",
      sourceId: "source-stale",
      name: "Created while list was in flight",
    });
    resolveList(
      Response.json({
        flows: [{ id: "stale-flow", name: "Stale" }],
      })
    );

    await expect(staleRead).resolves.toMatchObject({
      data: { flows: [{ id: "stale-flow" }] },
    });

    const refreshed = await fetchWhatsAppFlowsList({
      workspaceId: "workspace-stale-inflight",
      sourceId: "source-stale",
    });

    expect(refreshed.data?.flows?.[0]?.id).toBe("fresh-flow");
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("parses Flow action payloads as JSON objects only", () => {
    expect(parseWhatsAppFlowActionPayload("")).toEqual({});
    expect(parseWhatsAppFlowActionPayload('{"screen":"START"}')).toEqual({
      screen: "START",
    });
    expect(parseWhatsAppFlowActionPayload("[]")).toBeNull();
    expect(parseWhatsAppFlowActionPayload("{")).toBeNull();
  });

  it("passes draft mode when sending a draft Flow test", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      Response.json({
        success: true,
        messageId: "wamid.1",
      })
    );

    const result = await sendWhatsAppFlowTest({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      recipientPhone: "+77012345678",
      flowId: "flow-1",
      mode: "draft",
      flowToken: "token-1",
    });

    const body = JSON.parse(
      String((global.fetch as jest.Mock).mock.calls[0][1].body)
    );

    expect(result.ok).toBe(true);
    expect(body).toMatchObject({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      recipientPhone: "+77012345678",
      flowId: "flow-1",
      mode: "draft",
      flowToken: "token-1",
    });
  });

  it("sends the irreversible-message acknowledgement when deprecating", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      Response.json({ success: true, operation: "deprecate" })
    );

    await updateWhatsAppFlow({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      flowId: "flow-1",
      operation: "deprecate",
      acknowledgePreviouslySentMessagesWillStopOpening: true,
    });

    expect(
      JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body))
    ).toEqual({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      flowId: "flow-1",
      operation: "deprecate",
      acknowledgePreviouslySentMessagesWillStopOpening: true,
    });
  });

  it("refreshes cached Flow validation after a rejected JSON asset upload", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(
        Response.json({ flows: [{ id: "flow-draft", validation_errors: [] }] })
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "Flow JSON validation failed",
            validation_errors: [{ message: "Missing Footer" }],
          },
          { status: 400 }
        )
      )
      .mockResolvedValueOnce(
        Response.json({
          flows: [
            {
              id: "flow-draft",
              validation_errors: [{ message: "Missing Footer" }],
            },
          ],
        })
      );

    await fetchWhatsAppFlowsList({
      workspaceId: "ws-rejected-json",
      sourceId: "source-1",
    });
    const saved = await updateWhatsAppFlow({
      workspaceId: "ws-rejected-json",
      sourceId: "source-1",
      flowId: "flow-draft",
      operation: "update_json",
      flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
    });
    const refreshed = await fetchWhatsAppFlowsList({
      workspaceId: "ws-rejected-json",
      sourceId: "source-1",
    });

    expect(saved).toMatchObject({
      ok: false,
      status: 400,
      data: { validation_errors: [{ message: "Missing Footer" }] },
    });
    expect(refreshed.data?.flows?.[0]?.validation_errors).toEqual([
      { message: "Missing Footer" },
    ]);
    expect(
      JSON.parse(String((global.fetch as jest.Mock).mock.calls[1][1].body))
    ).toEqual({
      workspaceId: "ws-rejected-json",
      sourceId: "source-1",
      flowId: "flow-draft",
      operation: "update_json",
      flowJson: '{"version":"7.3","screens":[{"id":"START"}]}',
    });
  });

  it("sends the confirmed draft-deletion acknowledgement", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      Response.json({ success: true, flowId: "flow-1" })
    );

    await deleteWhatsAppFlow({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      flowId: "flow-1",
      acknowledgeDraftDeletion: true,
    });

    expect(
      JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body))
    ).toEqual({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      flowId: "flow-1",
      acknowledgeDraftDeletion: true,
    });
  });
});

describe("fetchTemplateFlowFacts", () => {
  const CHECKED_AT = "2026-09-28T12:00:00.000Z";
  const found = (flowId: string, screenIds: string[] | null = ["START"]) => ({
    flowId,
    state: "found",
    name: `Flow ${flowId}`,
    status: "PUBLISHED",
    screenIds,
    checkedAt: CHECKED_AT,
  });
  const requestedUrl = (call = 0) =>
    new URL(
      String((global.fetch as jest.Mock).mock.calls[call][0]),
      "http://localhost"
    );

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("asks the server once and answers repeat checks from memory", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      Response.json({ facts: [found("11"), found("12")] })
    );

    const first = await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-1",
      flowIds: ["11", "12", "11", "not-an-id"],
    });
    const second = await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-1",
      flowIds: ["12"],
    });

    expect(first).toEqual({ "11": found("11"), "12": found("12") });
    expect(second).toEqual({ "12": found("12") });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(requestedUrl().pathname).toBe("/api/whatsapp/flows/template-health");
    expect(requestedUrl().searchParams.get("flowIds")).toBe("11,12");
    expect(requestedUrl().searchParams.has("refresh")).toBe(false);
  });

  it("shares a request that is already on its way", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      Response.json({ facts: [found("21")] })
    );

    const [a, b] = await Promise.all([
      fetchTemplateFlowFacts({ workspaceId: "ws-facts-2", flowIds: ["21"] }),
      fetchTemplateFlowFacts({ workspaceId: "ws-facts-2", flowIds: ["21"] }),
    ]);

    expect(a).toEqual(b);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads Meta when forced", async () => {
    (global.fetch as jest.Mock).mockImplementation(async () =>
      Response.json({ facts: [found("31")] })
    );
    await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-3",
      flowIds: ["31"],
    });

    await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-3",
      sourceId: "source-1",
      flowIds: ["31"],
      force: true,
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(requestedUrl(1).searchParams.get("refresh")).toBe("1");
    expect(requestedUrl(1).searchParams.get("sourceId")).toBe("source-1");
  });

  it("marks Flows the server couldn't answer as unavailable and asks again later", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(Response.json({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ facts: [found("41")] }));

    const failed = await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-4",
      flowIds: ["41"],
    });
    const retried = await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-4",
      flowIds: ["41"],
    });

    expect(failed["41"]).toMatchObject({ flowId: "41", state: "unavailable" });
    expect(retried["41"]).toEqual(found("41"));
  });

  it("doesn't keep an open Flow whose screens couldn't be read", async () => {
    (global.fetch as jest.Mock).mockImplementation(async () =>
      Response.json({ facts: [found("51", null)] })
    );

    await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-5",
      flowIds: ["51"],
    });
    await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-5",
      flowIds: ["51"],
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("splits more than 25 Flows into several requests", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => String(600 + index));
    (global.fetch as jest.Mock).mockImplementation(async (input: string) => {
      const requested = new URL(input, "http://localhost").searchParams
        .get("flowIds")!
        .split(",");
      return Response.json({ facts: requested.map(id => found(id)) });
    });

    const facts = await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-6",
      flowIds: ids,
    });

    expect(Object.keys(facts)).toHaveLength(30);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("forgets cached answers when the app changes a Flow", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (input: string) =>
      String(input).includes("template-health")
        ? Response.json({ facts: [found("71")] })
        : Response.json({ success: true, operation: "publish" })
    );
    await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-7",
      flowIds: ["71"],
    });

    await updateWhatsAppFlow({
      workspaceId: "ws-facts-7",
      sourceId: "source-1",
      flowId: "71",
      operation: "publish",
    });
    await fetchTemplateFlowFacts({
      workspaceId: "ws-facts-7",
      flowIds: ["71"],
    });

    const healthCalls = (global.fetch as jest.Mock).mock.calls.filter(
      ([input]) => String(input).includes("template-health")
    );
    expect(healthCalls).toHaveLength(2);
  });
});
