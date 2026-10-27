/**
 * @jest-environment node
 */

const mockConnectDB = jest.fn();
const mockScenarioExists = jest.fn();
const mockHasProvisioningSourceRebindBlocker = jest.fn();
const mockFrom = jest.fn();
const mockClearSendContext = jest.fn();
const mockInvalidateSourceResolution = jest.fn();
const mockFenceAcquire = jest.fn();
const mockFenceAssertCurrent = jest.fn();
const mockFenceCommit = jest.fn();
const mockFenceRelease = jest.fn();
const mockFenceUpdateCurrent = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/models/scenario", () => ({
  Scenario: {
    exists: (...args: unknown[]) => mockScenarioExists(...args),
  },
}));
jest.mock("@/lib/whatsapp/flows/provisioning-operation-store", () => ({
  hasWhatsAppFlowProvisioningSourceRebindBlocker: (...args: unknown[]) =>
    mockHasProvisioningSourceRebindBlocker(...args),
}));
jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));
jest.mock("@/lib/whatsapp/send-context", () => ({
  clearWhatsAppSendContextCache: (...args: unknown[]) =>
    mockClearSendContext(...args),
}));
jest.mock("@/lib/whatsapp/source-resolver", () => ({
  invalidateWhatsAppSourceResolutionCache: (...args: unknown[]) =>
    mockInvalidateSourceResolution(...args),
}));
jest.mock("@/lib/whatsapp/flows/source-binding-fence-store", () => ({
  WhatsAppFlowSourceBindingFenceConflictError: class extends Error {},
  whatsAppFlowSourceBindingFenceStore: {
    acquire: (...args: unknown[]) => mockFenceAcquire(...args),
    assertCurrent: (...args: unknown[]) => mockFenceAssertCurrent(...args),
    commit: (...args: unknown[]) => mockFenceCommit(...args),
    release: (...args: unknown[]) => mockFenceRelease(...args),
    updateCurrent: (...args: unknown[]) => mockFenceUpdateCurrent(...args),
  },
}));

import {
  createWhatsAppSourceCredentialSnapshotSaver,
  invalidateWhatsAppSourceBindingCaches,
  loadCurrentWhatsAppSourceWabaBindings,
  ManagedWhatsAppFlowSourceRebindError,
  updateCurrentWhatsAppSourceCredentials,
  updateCurrentWhatsAppSourceCredentialsFromSnapshot,
  updateManagedWhatsAppSourceBinding,
} from "./source-rebind-guard";
import { WhatsAppFlowSourceBindingFenceConflictError } from "./source-binding-fence-store";

describe("managed WhatsApp Flow source rebind guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockScenarioExists.mockResolvedValue(null);
    mockHasProvisioningSourceRebindBlocker.mockResolvedValue(false);
    mockFenceAcquire.mockResolvedValue({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      expectedWabaId: "waba-old",
      kind: "REBIND",
      semanticOperationId: "rebind-1",
      ownerToken: "owner-1",
      fence: 1,
      leaseExpiresAt: new Date("2026-08-09T10:02:00.000Z"),
    });
    mockFenceAssertCurrent.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-old",
        __airi_whatsapp_flow_source_fence: 1,
      },
    });
    mockFenceCommit.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: {
        waba_id: "waba-new",
        __airi_whatsapp_flow_source_fence: 1,
      },
    });
    mockFenceRelease.mockResolvedValue(undefined);
    mockFenceUpdateCurrent.mockResolvedValue({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: { waba_id: "waba-old", refreshed: true },
    });
  });

  it("blocks replacing a WABA while the provisioning ledger reserves the source", async () => {
    mockHasProvisioningSourceRebindBlocker.mockResolvedValue(true);

    await expect(
      updateManagedWhatsAppSourceBinding({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentWabaId: "waba-old",
        nextWabaId: "waba-new",
        semanticOperationId: "rebind-1",
        buildCredentials: current => ({
          ...current,
          waba_id: "waba-new",
        }),
      })
    ).rejects.toBeInstanceOf(ManagedWhatsAppFlowSourceRebindError);

    expect(mockHasProvisioningSourceRebindBlocker).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "waba-old",
    });
    expect(mockFenceRelease).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a source update has no concrete next WABA", async () => {
    await expect(
      updateManagedWhatsAppSourceBinding({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentWabaId: "waba-old",
        nextWabaId: "",
        semanticOperationId: "rebind-1",
        buildCredentials: current => current,
      })
    ).rejects.toMatchObject({
      code: "WHATSAPP_FLOW_SOURCE_REBIND_BLOCKED",
    });
    expect(mockScenarioExists).not.toHaveBeenCalled();
  });

  it("loads normalized live WABA bindings in one bounded source query", async () => {
    const inQuery = jest.fn().mockResolvedValue({
      data: [
        { id: "source-1", credentials: { waba_id: "waba-1" } },
        { id: "source-2", credentials: {} },
      ],
      error: null,
    });
    const eqType = jest.fn(() => ({ in: inQuery }));
    const eqWorkspace = jest.fn(() => ({ eq: eqType }));
    const select = jest.fn(() => ({ eq: eqWorkspace }));
    mockFrom.mockReturnValue({ select });

    await expect(
      loadCurrentWhatsAppSourceWabaBindings({
        workspaceId: "workspace-1",
        sourceIds: ["source-1", "source-1", "source-2"],
      })
    ).resolves.toEqual({ "source-1": "waba-1" });
    expect(mockFrom).toHaveBeenCalledWith("sources");
    expect(inQuery).toHaveBeenCalledWith("id", ["source-1", "source-2"]);
  });

  it("fails activation closed by returning no live evidence when source loading fails", async () => {
    const inQuery = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: "unavailable" } });
    const eqType = jest.fn(() => ({ in: inQuery }));
    const eqWorkspace = jest.fn(() => ({ eq: eqType }));
    mockFrom.mockReturnValue({
      select: jest.fn(() => ({ eq: eqWorkspace })),
    });

    await expect(
      loadCurrentWhatsAppSourceWabaBindings({
        workspaceId: "workspace-1",
        sourceIds: ["source-1"],
      })
    ).resolves.toEqual({});
  });

  it("invalidates both credential-bearing WhatsApp caches", () => {
    invalidateWhatsAppSourceBindingCaches({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });

    expect(mockClearSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
    expect(mockInvalidateSourceResolution).toHaveBeenCalledTimes(1);
  });

  it("uses a CAS-only live-row update for a same-WABA credential refresh", async () => {
    const buildCredentials = jest.fn(current => ({
      ...current,
      refreshed: true,
    }));

    await expect(
      updateManagedWhatsAppSourceBinding({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentWabaId: "waba-old",
        nextWabaId: "waba-old",
        semanticOperationId: "refresh-1",
        buildCredentials,
      })
    ).resolves.toMatchObject({ credentials: { waba_id: "waba-old" } });

    expect(mockFenceUpdateCurrent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-old",
      buildCredentials,
    });
    expect(mockFenceAcquire).not.toHaveBeenCalled();
    expect(mockScenarioExists).not.toHaveBeenCalled();
  });

  it("exposes one cache-safe CAS helper for all same-WABA writers", async () => {
    const buildCredentials = jest.fn(current => ({
      ...current,
      webhook_last_checked: "2026-08-02T10:00:00.000Z",
    }));

    await updateCurrentWhatsAppSourceCredentials({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-old",
      buildCredentials,
    });

    expect(mockFenceUpdateCurrent).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-old",
      buildCredentials,
    });
    expect(mockClearSendContext).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
    });
    expect(mockInvalidateSourceResolution).toHaveBeenCalledTimes(1);
  });

  it("rejects a same-WABA credential write when the current phone binding changed", async () => {
    mockFenceUpdateCurrent.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials({
        waba_id: "waba-old",
        phone_number_id: "phone-new",
      }),
    }));

    await expect(
      updateCurrentWhatsAppSourceCredentials({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-old",
        expectedPhoneNumberId: "phone-old",
        buildCredentials: current => ({ ...current, refreshed: true }),
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
  });

  it("rejects derived diagnostics when a required credential revision changed", async () => {
    mockFenceUpdateCurrent.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials({
        waba_id: "waba-old",
        phone_number_id: "phone-old",
        access_token: "rotated-token",
      }),
    }));

    await expect(
      updateCurrentWhatsAppSourceCredentials({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-old",
        expectedPhoneNumberId: "phone-old",
        expectedCredentials: { access_token: "original-token" },
        buildCredentials: current => ({ ...current, refreshed: true }),
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
  });

  it("threads the optional phone binding guard through snapshot writers", async () => {
    mockFenceUpdateCurrent.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials({
        waba_id: "waba-old",
        phone_number_id: "phone-new",
      }),
    }));

    await expect(
      updateCurrentWhatsAppSourceCredentialsFromSnapshot({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedPhoneNumberId: "phone-old",
        currentCredentials: {
          waba_id: "waba-old",
          phone_number_id: "phone-old",
        },
        nextCredentials: {
          waba_id: "waba-old",
          phone_number_id: "phone-old",
          refreshed: true,
        },
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
  });

  it("three-way merges a stale derived snapshot without overwriting unrelated live fields", async () => {
    mockFenceUpdateCurrent.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials({
        waba_id: "waba-old",
        access_token: "newer-token",
        history_sync: { requested_at: "old" },
      }),
    }));

    await expect(
      updateCurrentWhatsAppSourceCredentialsFromSnapshot({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentCredentials: {
          waba_id: "waba-old",
          access_token: "stale-token",
          history_sync: { requested_at: "old" },
        },
        nextCredentials: {
          waba_id: "waba-old",
          access_token: "stale-token",
          history_sync: { requested_at: "new" },
        },
      })
    ).resolves.toMatchObject({
      credentials: {
        access_token: "newer-token",
        history_sync: { requested_at: "new" },
      },
    });
  });

  it("fails a stale derived writer closed when the field it changes also changed live", async () => {
    mockFenceUpdateCurrent.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials({
        waba_id: "waba-old",
        history_sync: { requested_at: "newer" },
      }),
    }));

    await expect(
      updateCurrentWhatsAppSourceCredentialsFromSnapshot({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentCredentials: {
          waba_id: "waba-old",
          history_sync: { requested_at: "old" },
        },
        nextCredentials: {
          waba_id: "waba-old",
          history_sync: { requested_at: "ours" },
        },
      })
    ).rejects.toBeTruthy();
    expect(mockClearSendContext).not.toHaveBeenCalled();
  });

  it("advances a sequential writer snapshot only after each successful CAS", async () => {
    let liveCredentials: Record<string, unknown> = {
      waba_id: "waba-old",
      cloud_contact_backfill: { status: "idle" },
    };
    mockFenceUpdateCurrent.mockImplementation(async params => {
      liveCredentials = params.buildCredentials(liveCredentials);
      return {
        id: "source-1",
        workspaceId: "workspace-1",
        credentials: liveCredentials,
      };
    });
    const saveCredentials = createWhatsAppSourceCredentialSnapshotSaver({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      currentCredentials: liveCredentials,
    });

    await saveCredentials({
      waba_id: "waba-old",
      cloud_contact_backfill: { status: "running" },
    });
    await saveCredentials({
      waba_id: "waba-old",
      cloud_contact_backfill: { status: "completed" },
    });

    expect(liveCredentials).toEqual({
      waba_id: "waba-old",
      cloud_contact_backfill: { status: "completed" },
    });
    expect(mockFenceUpdateCurrent).toHaveBeenCalledTimes(2);
  });

  it.each(["contact_sync", "history_sync", "cloud_contact_backfill"])(
    "rejects %s writes from a sequential saver after the phone binding changes",
    async field => {
      const currentCredentials = {
        waba_id: "waba-old",
        phone_number_id: "phone-old",
      };
      let liveCredentials: Record<string, unknown> = {
        ...currentCredentials,
        phone_number_id: "phone-new",
      };
      mockFenceUpdateCurrent.mockImplementation(async params => {
        liveCredentials = params.buildCredentials(liveCredentials);
        return {
          id: "source-1",
          workspaceId: "workspace-1",
          credentials: liveCredentials,
        };
      });
      const saveCredentials = createWhatsAppSourceCredentialSnapshotSaver({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedPhoneNumberId: "phone-old",
        currentCredentials,
      });

      await expect(
        saveCredentials({
          ...currentCredentials,
          [field]: { status: "running" },
        })
      ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
      await expect(
        saveCredentials({
          ...currentCredentials,
          [field]: { status: "failed" },
        })
      ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
      expect(liveCredentials).toEqual({
        waba_id: "waba-old",
        phone_number_id: "phone-new",
      });
    }
  );

  it("keeps the last acknowledged snapshot when a sequential CAS fails", async () => {
    let liveCredentials: Record<string, unknown> = {
      waba_id: "waba-old",
      cloud_contact_backfill: { status: "idle" },
    };
    mockFenceUpdateCurrent
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockImplementationOnce(async params => {
        liveCredentials = params.buildCredentials(liveCredentials);
        return {
          id: "source-1",
          workspaceId: "workspace-1",
          credentials: liveCredentials,
        };
      });
    const saveCredentials = createWhatsAppSourceCredentialSnapshotSaver({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      currentCredentials: liveCredentials,
    });

    await expect(
      saveCredentials({
        waba_id: "waba-old",
        cloud_contact_backfill: { status: "running" },
      })
    ).rejects.toThrow("temporary write failure");
    await expect(
      saveCredentials({
        waba_id: "waba-old",
        cloud_contact_backfill: { status: "completed" },
      })
    ).resolves.toMatchObject({
      credentials: {
        cloud_contact_backfill: { status: "completed" },
      },
    });
  });

  it("keeps snapshot conflict detection when the managed helper stays on the same WABA", async () => {
    mockFenceUpdateCurrent.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials({
        waba_id: "waba-old",
        history_sync: { requested_at: "newer" },
      }),
    }));

    await expect(
      updateManagedWhatsAppSourceBinding({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentWabaId: "waba-old",
        nextWabaId: "waba-old",
        semanticOperationId: "account-update-1",
        currentCredentials: {
          waba_id: "waba-old",
          history_sync: { requested_at: "old" },
        },
        nextCredentials: {
          waba_id: "waba-old",
          history_sync: { requested_at: "ours" },
        },
      })
    ).rejects.toBeTruthy();

    expect(mockFenceAcquire).not.toHaveBeenCalled();
    expect(mockClearSendContext).not.toHaveBeenCalled();
  });

  it("guards and commits a WABA change while holding the same activated fence", async () => {
    const buildCredentials = jest.fn(current => ({
      ...current,
      waba_id: "waba-new",
    }));

    await updateManagedWhatsAppSourceBinding({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      currentWabaId: "waba-old",
      nextWabaId: "waba-new",
      semanticOperationId: "rebind-1",
      buildCredentials,
      sourcePatch: { name: "WhatsApp (+1 555)" },
    });

    expect(mockFenceAcquire).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-old",
      kind: "REBIND",
      semanticOperationId: "rebind-1",
    });
    expect(mockHasProvisioningSourceRebindBlocker).toHaveBeenCalled();
    expect(mockFenceCommit).toHaveBeenCalledWith({
      lease: expect.objectContaining({ fence: 1, ownerToken: "owner-1" }),
      nextWabaId: "waba-new",
      buildCredentials,
      sourcePatch: { name: "WhatsApp (+1 555)" },
    });
    expect(mockFenceRelease).toHaveBeenCalledTimes(1);
    expect(mockFenceAcquire.mock.invocationCallOrder[0]).toBeLessThan(
      mockHasProvisioningSourceRebindBlocker.mock.invocationCallOrder[0]
    );
    expect(
      mockHasProvisioningSourceRebindBlocker.mock.invocationCallOrder[0]
    ).toBeLessThan(mockFenceCommit.mock.invocationCallOrder[0]);
  });

  it("blocks rebinds for managed or provider-referenced template and service Flows", async () => {
    mockScenarioExists.mockResolvedValue({ _id: "scenario-1" });

    await expect(
      updateManagedWhatsAppSourceBinding({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        currentWabaId: "waba-old",
        nextWabaId: "waba-new",
        semanticOperationId: "rebind-1",
        buildCredentials: current => ({
          ...current,
          waba_id: "waba-new",
        }),
      })
    ).rejects.toBeInstanceOf(ManagedWhatsAppFlowSourceRebindError);

    expect(mockScenarioExists).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      deletedAt: null,
      $or: expect.arrayContaining([
        {
          "nodes.data.actionFlowConfig.managedProvisioning.sourceId":
            "source-1",
        },
        {
          "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.managedProvisioning.sourceId":
            "source-1",
        },
        {
          "nodes.data.actionFlowConfig.providerReference.sourceId": "source-1",
        },
        {
          "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.providerReference.sourceId":
            "source-1",
        },
      ]),
    });
    expect(mockFenceCommit).not.toHaveBeenCalled();
    expect(mockFenceRelease).toHaveBeenCalledTimes(1);
  });

  it("recovers an exact unbound existing source through the fenced rebind path", async () => {
    mockFenceAssertCurrent.mockResolvedValueOnce({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: { __airi_whatsapp_flow_source_fence: 1 },
    });

    await updateManagedWhatsAppSourceBinding({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      currentWabaId: "",
      nextWabaId: "waba-new",
      semanticOperationId: "bind-unbound-1",
      buildCredentials: current => ({
        ...current,
        waba_id: "waba-new",
      }),
    });

    expect(mockFenceAcquire).toHaveBeenCalledWith(
      expect.objectContaining({ expectedWabaId: "" })
    );
    expect(mockHasProvisioningSourceRebindBlocker).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      wabaId: "",
    });
    expect(mockFenceCommit).toHaveBeenCalledTimes(1);
  });
});
