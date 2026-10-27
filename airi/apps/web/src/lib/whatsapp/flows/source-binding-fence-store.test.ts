/**
 * @jest-environment node
 */

import { createClient } from "@supabase/supabase-js";

const mockSupabaseFrom = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

import {
  createWhatsAppFlowSourceBindingFenceStore,
  WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD,
  whatsAppFlowSourceBindingFenceStore,
  WhatsAppFlowSourceBindingFenceConflictError,
  type WhatsAppFlowSourceBindingFenceStoreDependencies,
} from "./source-binding-fence-store";
import { resetWhatsAppPhoneScopedState } from "@/lib/whatsapp/credentials";

const NOW = new Date("2026-08-09T10:00:00.000Z");
const EXPIRY = new Date("2026-08-09T10:02:00.000Z");
const SOURCE_UPDATED_AT = "2026-08-09T09:59:00.000Z";
const NEXT_SOURCE_UPDATED_AT = "2026-08-09T10:00:00.000Z";

type CapturedSupabaseRequest = {
  url: URL;
  method: string;
};

function useDefaultAdapterSupabase(params?: {
  patchResponse?(request: CapturedSupabaseRequest): unknown[];
}) {
  const requests: CapturedSupabaseRequest[] = [];
  const credentials = {
    waba_id: "waba-1",
    access_token: {
      iv: "source-iv",
      tag: "source-tag",
      ciphertext: "encrypted-secret",
    },
    unknown_future_field: { keep: true },
  };
  const client = createClient("https://example.supabase.co", "test-key", {
    global: {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input
        );
        const method = (
          init?.method || (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const request = { url, method };
        requests.push(request);

        const rows =
          method === "PATCH"
            ? (params?.patchResponse?.(request) ?? [
                {
                  id: "source-1",
                  workspace_id: "workspace-1",
                  credentials: {
                    ...credentials,
                    access_token: {
                      iv: "next-iv",
                      tag: "next-tag",
                      ciphertext: "refreshed-secret",
                    },
                  },
                  updated_at: NEXT_SOURCE_UPDATED_AT,
                },
              ])
            : [
                {
                  id: "source-1",
                  workspace_id: "workspace-1",
                  credentials,
                  updated_at: SOURCE_UPDATED_AT,
                },
              ];

        // PostgREST answers an object Accept with one row or a 406; any other
        // Accept gets the row array (supabase-js 2.116 maybeSingle sends no
        // object Accept and maps [] to null itself).
        const wantsObject = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : {})
        )
          .get("accept")
          ?.includes("application/vnd.pgrst.object+json");

        if (wantsObject && rows.length !== 1) {
          return new Response(
            JSON.stringify({
              code: "PGRST116",
              details: `The result contains ${rows.length} rows`,
              hint: null,
              message: "Cannot coerce the result to a single JSON object",
            }),
            {
              status: 406,
              headers: { "content-type": "application/json" },
            }
          );
        }

        const data = wantsObject ? rows[0] : rows;

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    },
  });
  mockSupabaseFrom.mockImplementation((relation: string) =>
    client.from(relation)
  );
  return { requests };
}

function source(
  credentials: Record<string, unknown>,
  updatedAt = SOURCE_UPDATED_AT
) {
  return {
    id: "source-1",
    workspaceId: "workspace-1",
    updatedAt,
    credentials,
  };
}

function dependencies(
  overrides: Partial<WhatsAppFlowSourceBindingFenceStoreDependencies> = {}
) {
  let sourceRevision = 0;
  let currentSource = source({
    waba_id: "waba-1",
    access_token: "encrypted",
    unknown_future_field: { keep: true },
  });
  let activeFence = 1;
  let activeOwner = "owner-1";
  const deps: WhatsAppFlowSourceBindingFenceStoreDependencies = {
    now: () => NOW,
    newOwnerToken: () => "owner-1",
    acquireMongoFence: jest.fn().mockResolvedValue({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      kind: "PROVISIONING",
      semanticOperationId: "operation-1",
      ownerToken: "owner-1",
      fence: 1,
      leaseExpiresAt: EXPIRY,
    }),
    renewMongoFence: jest.fn().mockImplementation(async ({ lease }) => {
      if (lease.ownerToken !== activeOwner || lease.fence !== activeFence) {
        return null;
      }
      return { ...lease, leaseExpiresAt: EXPIRY };
    }),
    assertMongoFence: jest
      .fn()
      .mockImplementation(
        async ({ lease }) =>
          lease.ownerToken === activeOwner && lease.fence === activeFence
      ),
    releaseMongoFence: jest.fn().mockImplementation(async lease => {
      if (lease.ownerToken === activeOwner && lease.fence === activeFence) {
        activeOwner = "";
      }
    }),
    loadSource: jest.fn().mockImplementation(async () => currentSource),
    compareAndSetSource: jest
      .fn()
      .mockImplementation(async ({ expectedUpdatedAt, nextCredentials }) => {
        if (expectedUpdatedAt !== currentSource.updatedAt) return null;
        sourceRevision += 1;
        currentSource = source(
          nextCredentials,
          new Date(
            Date.parse(SOURCE_UPDATED_AT) + sourceRevision * 1_000
          ).toISOString()
        );
        return currentSource;
      }),
    ...overrides,
  };
  return {
    deps,
    setMongoFence(fence: number, ownerToken: string) {
      activeFence = fence;
      activeOwner = ownerToken;
    },
    getSource: () => currentSource,
  };
}

describe("WhatsApp Flow source-binding fence store", () => {
  beforeEach(() => {
    mockSupabaseFrom.mockReset();
  });

  it("disables conversion feedback after a WABA rebind but preserves it on token refresh", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    const config = {
      enabled: true,
      waba_id: "waba-1",
      dataset_id: "dataset-1",
      configured_at: NOW.toISOString(),
    };
    await store.updateCurrent({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      buildCredentials: current => ({
        ...current,
        conversions_api: config,
        sales_webhook_secret: { ciphertext: "encrypted" },
      }),
    });
    const refreshed = await store.updateCurrent({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      buildCredentials: current => ({ ...current, access_token: "rotated" }),
    });
    expect(refreshed.credentials.conversions_api).toEqual(config);
    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "REBIND",
      semanticOperationId: "rebind-conversions",
    });
    const rebound = await store.commit({
      lease,
      nextWabaId: "waba-2",
      buildCredentials: current => ({ ...current, waba_id: "waba-2" }),
    });
    expect(rebound.credentials.conversions_api).toEqual({
      ...config,
      enabled: false,
      attribution_boundary_at: NOW.toISOString(),
    });
    expect(rebound.credentials.sales_webhook_secret).toEqual({
      ciphertext: "encrypted",
    });
  });

  it("records a WABA-change boundary even before conversion feedback was configured", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "REBIND",
      semanticOperationId: "rebind-before-meta",
    });
    const rebound = await store.commit({
      lease,
      nextWabaId: "waba-2",
      buildCredentials: current => ({ ...current, waba_id: "waba-2" }),
    });
    expect(rebound.credentials.conversions_api).toEqual({
      enabled: false,
      attribution_boundary_at: NOW.toISOString(),
    });
    const refreshed = await store.updateCurrent({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-2",
      buildCredentials: current => ({ ...current, access_token: "rotated" }),
    });
    expect(refreshed.credentials.conversions_api).toEqual(
      rebound.credentials.conversions_api
    );
  });

  it("uses updated_at as the opaque default-adapter CAS token without putting credentials in the URL", async () => {
    const { requests } = useDefaultAdapterSupabase();

    const updated = await whatsAppFlowSourceBindingFenceStore.updateCurrent({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      buildCredentials: current => ({
        ...current,
        access_token: {
          iv: "next-iv",
          tag: "next-tag",
          ciphertext: "refreshed-secret",
        },
      }),
    });

    const patchRequest = requests.find(request => request.method === "PATCH");
    expect(patchRequest?.url.searchParams.get("updated_at")).toBe(
      `eq.${SOURCE_UPDATED_AT}`
    );
    expect(patchRequest?.url.searchParams.has("credentials")).toBe(false);
    expect(patchRequest?.url.toString()).not.toContain("encrypted-secret");
    expect(updated.credentials.access_token).toEqual({
      iv: "next-iv",
      tag: "next-tag",
      ciphertext: "refreshed-secret",
    });
  });

  it("fails closed when the default adapter loses its updated_at CAS", async () => {
    useDefaultAdapterSupabase({
      patchResponse: request =>
        request.url.searchParams.get("updated_at") === `eq.${SOURCE_UPDATED_AT}`
          ? []
          : [
              {
                id: "source-1",
                workspace_id: "workspace-1",
                credentials: {
                  waba_id: "waba-1",
                  access_token: {
                    iv: "next-iv",
                    tag: "next-tag",
                    ciphertext: "refreshed-secret",
                  },
                },
                updated_at: NEXT_SOURCE_UPDATED_AT,
              },
            ],
    });

    await expect(
      whatsAppFlowSourceBindingFenceStore.updateCurrent({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        buildCredentials: current => ({
          ...current,
          access_token: {
            iv: "next-iv",
            tag: "next-tag",
            ciphertext: "refreshed-secret",
          },
        }),
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
  });

  it("activates the acquired Mongo fence in the protected Supabase row", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);

    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "PROVISIONING",
      semanticOperationId: "operation-1",
    });

    expect(lease).toMatchObject({ ownerToken: "owner-1", fence: 1 });
    expect(state.getSource().credentials).toEqual({
      waba_id: "waba-1",
      access_token: "encrypted",
      unknown_future_field: { keep: true },
      [WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD]: 1,
    });
  });

  it("releases Mongo ownership and fails closed when activation loses its exact-row CAS", async () => {
    const releaseMongoFence = jest.fn().mockResolvedValue(undefined);
    const state = dependencies({
      compareAndSetSource: jest.fn().mockResolvedValue(null),
      releaseMongoFence,
    });
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);

    await expect(
      store.acquire({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        kind: "REBIND",
        semanticOperationId: "rebind-1",
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
    expect(releaseMongoFence).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale holder after a successor activates the next fence", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    const stale = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "PROVISIONING",
      semanticOperationId: "operation-1",
    });
    state.setMongoFence(2, "owner-2");

    await expect(store.assertCurrent(stale)).rejects.toBeInstanceOf(
      WhatsAppFlowSourceBindingFenceConflictError
    );
  });

  it("requires both a live Mongo lease and the activated Supabase fence", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "PROVISIONING",
      semanticOperationId: "operation-1",
    });
    state.getSource().credentials[WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD] =
      99;

    await expect(store.assertCurrent(lease)).rejects.toBeInstanceOf(
      WhatsAppFlowSourceBindingFenceConflictError
    );
  });

  it("commits a rebind with the active fence and preserves unknown fields", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "REBIND",
      semanticOperationId: "rebind-1",
    });

    const committed = await store.commit({
      lease,
      nextWabaId: "waba-2",
      buildCredentials: current => ({
        ...current,
        waba_id: "waba-2",
        access_token: "next-encrypted",
      }),
      sourcePatch: { name: "WhatsApp (+1 555)" },
    });

    expect(committed.credentials).toEqual(
      expect.objectContaining({
        waba_id: "waba-2",
        access_token: "next-encrypted",
        unknown_future_field: { keep: true },
        [WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD]: 1,
      })
    );
    expect(state.deps.compareAndSetSource).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourcePatch: { name: "WhatsApp (+1 555)" },
      })
    );
  });

  it("treats a zero-row protected commit as a lost fence", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      kind: "REBIND",
      semanticOperationId: "rebind-1",
    });
    (state.deps.compareAndSetSource as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      store.commit({
        lease,
        nextWabaId: "waba-2",
        buildCredentials: current => ({ ...current, waba_id: "waba-2" }),
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
  });

  it("CAS-updates a same-WABA credential refresh from the live row without a lease", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);

    const updated = await store.updateCurrent({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "waba-1",
      buildCredentials: current => ({
        ...current,
        access_token: "refreshed-encrypted",
      }),
    });

    expect(updated.credentials).toEqual({
      waba_id: "waba-1",
      access_token: "refreshed-encrypted",
      unknown_future_field: { keep: true },
    });
    expect(state.deps.acquireMongoFence).not.toHaveBeenCalled();
  });

  describe("when a source switches to another phone number", () => {
    const phoneScopedState = {
      phone_registered: true,
      phone_registered_at: "2026-09-01T00:00:00.000Z",
      phone_registration_status: "CONNECTED",
      phone_registration_error: "previous error",
      contact_sync: { requested_at: "2026-09-01T00:00:00.000Z" },
      history_sync: { requested_at: "2026-09-01T00:00:00.000Z" },
    };
    const cleared = Object.fromEntries(
      Object.keys(phoneScopedState).map(key => [key, null])
    );

    async function storeWithOldNumber() {
      const state = dependencies();
      const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
      await store.updateCurrent({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        buildCredentials: current => ({
          ...current,
          phone_number_id: "phone-old",
          ...phoneScopedState,
        }),
      });
      return { state, store };
    }

    // The store merges the candidate onto the stored row, so the old
    // number's state must be cleared with null rather than deleted.
    it("clears the old number's state on a same-WABA update", async () => {
      const { state, store } = await storeWithOldNumber();

      await store.updateCurrent({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        buildCredentials: current => ({
          ...resetWhatsAppPhoneScopedState(current, "phone-new"),
          phone_number_id: "phone-new",
        }),
      });

      expect(state.getSource().credentials).toEqual(
        expect.objectContaining({ phone_number_id: "phone-new", ...cleared })
      );
    });

    it("clears the old number's state on a WABA rebind", async () => {
      const { state, store } = await storeWithOldNumber();
      const lease = await store.acquire({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        kind: "REBIND",
        semanticOperationId: "rebind-1",
      });

      await store.commit({
        lease,
        nextWabaId: "waba-2",
        buildCredentials: current => ({
          ...resetWhatsAppPhoneScopedState(current, "phone-new"),
          phone_number_id: "phone-new",
          waba_id: "waba-2",
        }),
      });

      expect(state.getSource().credentials).toEqual(
        expect.objectContaining({
          phone_number_id: "phone-new",
          waba_id: "waba-2",
          ...cleared,
        })
      );
    });
  });

  it("fails a stale same-WABA writer closed when a concurrent fence changes the row", async () => {
    const state = dependencies();
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);
    (state.deps.compareAndSetSource as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      store.updateCurrent({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        buildCredentials: current => ({ ...current, status: "ready" }),
      })
    ).rejects.toBeInstanceOf(WhatsAppFlowSourceBindingFenceConflictError);
  });

  it("fences and binds an exact null/unbound source row without substituting the next WABA", async () => {
    let current: {
      id: string;
      workspaceId: string;
      updatedAt: string;
      credentials: Record<string, unknown>;
    } = {
      id: "source-1",
      workspaceId: "workspace-1",
      updatedAt: SOURCE_UPDATED_AT,
      credentials: {},
    };
    const compareAndSetSource = jest
      .fn()
      .mockImplementation(async ({ expectedUpdatedAt, nextCredentials }) => {
        if (expectedUpdatedAt !== current.updatedAt) return null;
        current = {
          ...current,
          updatedAt: NEXT_SOURCE_UPDATED_AT,
          credentials: nextCredentials,
        };
        return current;
      });
    const state = dependencies({
      loadSource: jest.fn().mockImplementation(async () => current),
      compareAndSetSource,
    });
    const store = createWhatsAppFlowSourceBindingFenceStore(state.deps);

    const lease = await store.acquire({
      workspaceId: "workspace-1",
      sourceId: "source-1",
      expectedWabaId: "",
      kind: "REBIND",
      semanticOperationId: "bind-unbound-1",
    });
    const committed = await store.commit({
      lease,
      nextWabaId: "waba-new",
      buildCredentials: credentials => ({
        ...credentials,
        waba_id: "waba-new",
      }),
    });

    expect(compareAndSetSource).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ expectedUpdatedAt: SOURCE_UPDATED_AT })
    );
    expect(committed.credentials).toMatchObject({
      waba_id: "waba-new",
      [WHATSAPP_FLOW_SOURCE_FENCE_CREDENTIAL_FIELD]: 1,
    });
  });
});
