import {
  fetchScenarioGeneratorJobRequest,
  fetchScenarioGeneratorRecipientMessages,
  patchScenarioGeneratorRecipientMessage,
  sendGeneratedScenarioCampaignRequest,
  submitGeneratedScenarioTemplateRequest,
  GeneratedTemplateSubmissionError,
} from "./generator";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("scenario generator client", () => {
  it.each(
    [
      [{ id: "action-1", data: { kind: "unknown" } }],
      [{ id: "action-1", data: {} }],
      [{ id: "action-1", data: null }],
      [{ id: "action-1" }],
      [{ id: " ", data: { kind: "action" } }],
      [
        { id: "action-1", data: { kind: "action" } },
        { id: " action-1 ", data: { kind: "action" } },
      ],
      null,
      {},
    ].map(nodeUpdates => ({ nodeUpdates }))
  )(
    "rejects malformed generation node updates: %j",
    async ({ nodeUpdates }) => {
      global.fetch = jest.fn().mockResolvedValue(jsonResponse({ nodeUpdates }));

      await expect(
        fetchScenarioGeneratorJobRequest({
          workspaceId: "workspace-1",
          jobId: "job-1",
          errorFallback: "Failed to refresh generation job",
        })
      ).rejects.toThrow("Invalid scenario generation update");
    }
  );

  it("preserves supported incomplete drafts and absent generation updates", async () => {
    const nodeUpdates = [
      { id: "trigger", data: { kind: "trigger", triggerType: "legacy" } },
      { id: "bulk", data: { kind: "bulk" } },
      { id: "context", data: { kind: "context" } },
      { id: "logic", data: { kind: "logic" } },
      { id: "link", data: { kind: "scenario_link" } },
      {
        id: "action",
        data: {
          kind: "action",
          actionGenerativeAIConfig: {
            version: 1,
            mode: "text_to_image",
            prompt: "",
          },
        },
      },
    ];
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ nodeUpdates }))
      .mockResolvedValueOnce(jsonResponse({ generationJobId: "job-1" }));
    const params = {
      workspaceId: "workspace-1",
      jobId: "job-1",
      errorFallback: "Failed to refresh generation job",
    };

    await expect(fetchScenarioGeneratorJobRequest(params)).resolves.toEqual({
      nodeUpdates,
    });
    await expect(fetchScenarioGeneratorJobRequest(params)).resolves.toEqual({
      generationJobId: "job-1",
    });
  });

  it("posts generated campaign send through the workspace generator route", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ campaignId: "cmp-1", scenarioUpdate: { nodes: [] } })
      );

    await expect(
      sendGeneratedScenarioCampaignRequest({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        idempotencyKey: "idem-12345678",
        acknowledgeMediaFailures: true,
        errorFallback: "Failed to queue bulk send",
      })
    ).resolves.toEqual({
      campaignId: "cmp-1",
      scenarioUpdate: { nodes: [] },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/workspaces/workspace-1/scenario-generator/send",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scenarioId: "scenario-1",
          idempotencyKey: "idem-12345678",
          acknowledgeMediaFailures: true,
        }),
      })
    );
  });

  it("throws BulkCampaignSendError when generated send fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Audience overlap" }, 409));

    await expect(
      sendGeneratedScenarioCampaignRequest({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        idempotencyKey: "idem-12345678",
        errorFallback: "Failed to queue bulk send",
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "BulkCampaignSendError",
        message: "Audience overlap",
        status: 409,
      })
    );
  });

  it("submits generated templates and loads recipient messages", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          templateId: "tmpl-1",
          status: "submitted",
          scenarioUpdate: {
            nodeId: "action-1",
            previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
            scenarioUpdatedAt: "2026-01-01T00:00:00.001Z",
            patch: {
              generatedTemplateDraft: {
                id: "draft-1",
                name: "offer",
                language: "en",
                status: "submitted",
              },
            },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: "msg-1", channel: "whatsapp", recipient: "+1", text: "Hi" },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(
        jsonResponse({ generationJobId: "job-1", nodeUpdates: [] })
      );

    await expect(
      submitGeneratedScenarioTemplateRequest({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "action-1",
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        templateId: "tmpl-1",
        status: "submitted",
        scenarioUpdate: expect.objectContaining({ nodeId: "action-1" }),
      })
    );

    await expect(
      fetchScenarioGeneratorRecipientMessages({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        branchId: "yes",
      })
    ).resolves.toEqual({
      items: [
        { id: "msg-1", channel: "whatsapp", recipient: "+1", text: "Hi" },
      ],
      total: 1,
      truncated: false,
    });

    await patchScenarioGeneratorRecipientMessage({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
      messageId: "msg-1",
      text: "Hello",
    });

    await expect(
      fetchScenarioGeneratorJobRequest({
        workspaceId: "workspace-1",
        jobId: "job-1",
        errorFallback: "Failed to refresh generation job",
      })
    ).resolves.toEqual({ generationJobId: "job-1", nodeUpdates: [] });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/workspaces/workspace-1/scenario-generator/submit-template",
      expect.objectContaining({ method: "POST" })
    );
    expect(String((global.fetch as jest.Mock).mock.calls[1][0])).toContain(
      "/api/workspaces/workspace-1/scenario-generator/recipient-messages?"
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      "/api/workspaces/workspace-1/scenario-generator/recipient-messages",
      expect.objectContaining({ method: "PATCH" })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      4,
      "/api/workspaces/workspace-1/scenario-generator/jobs/job-1",
      { cache: "no-store" }
    );
  });

  it("preserves a committed rejection update on its typed error", async () => {
    const scenarioUpdate = {
      nodeId: "action-1",
      previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
      scenarioUpdatedAt: "2026-01-01T00:00:00.001Z",
      patch: {
        generatedTemplateDraft: {
          id: "draft-1",
          name: "offer",
          language: "en",
          status: "rejected" as const,
        },
      },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Meta rejected it", scenarioUpdate }, 400)
      );

    await expect(
      submitGeneratedScenarioTemplateRequest({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "action-1",
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GeneratedTemplateSubmissionError>>({
        name: "GeneratedTemplateSubmissionError",
        message: "Meta rejected it",
        status: 400,
        scenarioUpdate,
      })
    );
  });

  it.each([
    {},
    {
      scenarioUpdate: {
        nodeId: "action-1",
        previousScenarioUpdatedAt: "not-a-revision",
        scenarioUpdatedAt: "2026-01-01T00:00:00.001Z",
        patch: {},
      },
    },
    {
      scenarioUpdate: {
        nodeId: "action-1",
        previousScenarioUpdatedAt: "2026-01-01T00:00:00.000Z",
        scenarioUpdatedAt: "2026-01-01T00:00:00.001Z",
        patch: {
          generatedTemplateDraft: {
            id: "draft-1",
            name: "offer",
            language: "en",
            status: "submitted",
          },
          arbitraryServerField: true,
        },
      },
    },
  ])("rejects malformed successful submission payloads %#", async payload => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(payload));

    await expect(
      submitGeneratedScenarioTemplateRequest({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        nodeId: "action-1",
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GeneratedTemplateSubmissionError",
        message: "Invalid generated template submission response",
        status: 200,
      })
    );
  });

  it("surfaces truncated recipient-message pages", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        total: 150,
        items: [
          { id: "msg-1", channel: "whatsapp", recipient: "+1", text: "Hi" },
        ],
      })
    );

    await expect(
      fetchScenarioGeneratorRecipientMessages({
        workspaceId: "workspace-1",
        scenarioId: "scenario-1",
        branchId: "yes",
        limit: 100,
      })
    ).resolves.toEqual({
      items: [
        { id: "msg-1", channel: "whatsapp", recipient: "+1", text: "Hi" },
      ],
      total: 150,
      truncated: true,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("recipient-messages?"),
      { cache: "no-store" }
    );
  });
});
