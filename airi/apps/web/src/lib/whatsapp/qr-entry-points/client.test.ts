/**
 * @jest-environment node
 */

import {
  createWhatsAppQrDraft,
  fetchWhatsAppQrEntryPoint,
  fetchWhatsAppQrEntryPoints,
  fetchWhatsAppQrProviderCodes,
  fetchWhatsAppQrScenarioSummaries,
  inspectWhatsAppQrImport,
  patchWhatsAppQrEntryPoint,
  postWhatsAppQrAssignmentCommand,
  postWhatsAppQrCommand,
} from "./client";

describe("WhatsApp QR entry-points client", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("does not auto-call fetch on import", () => {
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches scenario QR summaries", async () => {
    const payload = {
      summaries: {
        "node-1": {
          entryPointId: "entry-1",
          placementName: "Door",
          status: "DRAFT",
          hasCurrentCode: false,
          version: 0,
        },
      },
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json(payload));

    const result = await fetchWhatsAppQrScenarioSummaries({
      workspaceId: "workspace-1",
      scenarioId: "scenario-1",
    });

    expect(result).toEqual({ ok: true, data: payload });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/scenarios/scenario-1/whatsapp-qr/summary?workspaceId=workspace-1",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("puts multipart ownership identifiers in the authenticated request URL", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json({
        intent: {
          kind: "provider",
          providerCode: "ABC",
          deepLink: "https://wa.me/message/ABC",
        },
      })
    );
    const file = new File([new Uint8Array([1, 2, 3])], "qr.png", {
      type: "image/png",
    });

    await inspectWhatsAppQrImport({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      file,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points/inspect?workspaceId=workspace-1&sourceId=source-1",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) })
    );
    const init = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get("image")).toBe(file);
    expect(body.get("workspaceId")).toBeNull();
    expect(body.get("sourceId")).toBeNull();
  });

  it("fetches one encoded provider-code page with its opaque cursor", async () => {
    const payload = {
      codes: [
        {
          code: "ABC",
          prefilledMessage: "Hi",
          deepLink: "https://wa.me/message/ABC",
        },
      ],
      nextCursor: "opaque-next",
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json(payload));
    const controller = new AbortController();

    const result = await fetchWhatsAppQrProviderCodes({
      workspaceId: "workspace / 1",
      sourceId: "source / 1",
      limit: 25,
      cursor: "opaque+cursor",
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: true, data: payload });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points/provider-codes?workspaceId=workspace+%2F+1&sourceId=source+%2F+1&limit=25&cursor=opaque%2Bcursor",
      { signal: controller.signal, cache: "no-store" }
    );
  });

  it("requires Idempotency-Key on commands", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json({ status: "applied", entryPointId: "entry-1" })
    );

    const result = await postWhatsAppQrCommand({
      body: {
        command: "create",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        entryPointId: "entry-1",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      },
      idempotencyKey: "idem-1",
    });

    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points/commands",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "idem-1",
        },
      })
    );
  });

  it("posts local assignment commands without provider or operation fields", async () => {
    const resultPayload = {
      entryPointId: "entry-1",
      entryPointVersion: 4,
      assignment: null,
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json(resultPayload)
    );

    const result = await postWhatsAppQrAssignmentCommand({
      body: {
        command: "unassign",
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
        expectedEntryPointVersion: 3,
        sourceExpectedUpdatedAt: "2026-08-10T10:00:00.000Z",
      },
    });

    expect(result).toEqual({ ok: true, data: resultPayload });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points/assignments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "unassign",
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          expectedEntryPointVersion: 3,
          sourceExpectedUpdatedAt: "2026-08-10T10:00:00.000Z",
        }),
      }
    );
  });

  it("surfaces reconcile-required commands as incomplete and preserves the operation id", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json(
        {
          status: "reconcile_required",
          entryPointId: "entry-1",
          operationId: "operation-1",
        },
        { status: 202 }
      )
    );

    const result = await postWhatsAppQrCommand({
      body: {
        command: "create",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        entryPointId: "entry-1",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      },
      idempotencyKey: "idem-1",
    });

    expect(result).toEqual({
      ok: false,
      status: 202,
      error: "WhatsApp QR provider state requires reconciliation",
      code: "RECONCILE_REQUIRED",
      operationId: "operation-1",
    });
  });

  it("rejects empty idempotency keys without calling fetch", async () => {
    const result = await postWhatsAppQrCommand({
      body: {
        command: "create",
        workspaceId: "workspace-1",
        sourceId: "source-1",
        entryPointId: "entry-1",
        desiredMessage: "Hi",
        expectedEntryPointVersion: 0,
      },
      idempotencyKey: "   ",
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "Idempotency-Key is required",
      code: "INVALID_INPUT",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fetches one encoded Manager page with one facet and forwards AbortSignal", async () => {
    const payload = { items: [], nextCursor: null };
    (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json(payload));
    const controller = new AbortController();

    const result = await fetchWhatsAppQrEntryPoints({
      workspaceId: "workspace / 1",
      query: "Store & front",
      facet: { kind: "source", sourceId: "source/1" },
      cursor: "abc+",
      limit: 25,
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: true, data: payload });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points?workspaceId=workspace+%2F+1&query=Store+%26+front&facet=source&value=source%2F1&cursor=abc%2B&limit=25",
      { signal: controller.signal, cache: "no-store" }
    );
  });

  it("creates a stable local draft with no provider command", async () => {
    const detail = {
      entryPoint: {
        entryPointId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "workspace-1",
        placementName: "Store front",
        status: "DRAFT",
        version: 0,
      },
      historicalCodes: [],
      historicalCodesHasMore: false,
      canCreateReplacement: true,
    };
    (global.fetch as jest.Mock).mockResolvedValueOnce(Response.json(detail));

    await expect(
      createWhatsAppQrDraft({
        workspaceId: "workspace-1",
        entryPointId: "11111111-1111-4111-8111-111111111111",
        placementName: "Store front",
        desiredMessage: "Hello",
      })
    ).resolves.toEqual({ ok: true, data: detail });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "workspace-1",
          entryPointId: "11111111-1111-4111-8111-111111111111",
          placementName: "Store front",
          desiredMessage: "Hello",
        }),
      })
    );
  });

  it("fetches encoded resource detail and parses structured errors", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json(
        { error: "Version conflict", code: "VERSION_CONFLICT" },
        { status: 409 }
      )
    );
    const controller = new AbortController();

    await expect(
      fetchWhatsAppQrEntryPoint({
        workspaceId: "workspace / 1",
        entryPointId: "entry / 1",
        signal: controller.signal,
      })
    ).resolves.toEqual({
      ok: false,
      status: 409,
      error: "Version conflict",
      code: "VERSION_CONFLICT",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points/entries/entry%20%2F%201?workspaceId=workspace+%2F+1",
      { signal: controller.signal, cache: "no-store" }
    );
  });

  it("patches Manager-owned fields at the resource detail path", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      Response.json({ entryPoint: { version: 4 } })
    );
    const controller = new AbortController();

    await patchWhatsAppQrEntryPoint({
      workspaceId: "workspace-1",
      entryPointId: "11111111-1111-4111-8111-111111111111",
      expectedVersion: 3,
      placementName: "Changed",
      signal: controller.signal,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/whatsapp/qr-entry-points/entries/11111111-1111-4111-8111-111111111111",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          workspaceId: "workspace-1",
          expectedVersion: 3,
          placementName: "Changed",
        }),
      }
    );
  });
});
