/**
 * @jest-environment node
 */

const mockGetMembership = jest.fn();
const mockUpdateCredentials = jest.fn();

jest.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock("@/lib/auth/workspace-membership", () => ({
  getAuthenticatedWorkspaceMembership: (...args: unknown[]) =>
    mockGetMembership(...args),
}));

jest.mock("@/lib/whatsapp/flows/source-rebind-guard", () => ({
  updateCurrentWhatsAppSourceCredentials: (...args: unknown[]) =>
    mockUpdateCredentials(...args),
}));

jest.mock("@/lib/whatsapp/reconnect-status", () => ({
  ...jest.requireActual("@/lib/whatsapp/reconnect-status"),
  getWhatsAppReconnectStatus: jest.fn(),
}));

jest.mock("@/lib/whatsapp/flows/source-binding-fence-store", () => ({
  WhatsAppFlowSourceBindingFenceConflictError: class WhatsAppFlowSourceBindingFenceConflictError extends Error {},
}));

import * as reconnectStatusRoute from "./route";
import { WhatsAppFlowSourceBindingFenceConflictError } from "@/lib/whatsapp/flows/source-binding-fence-store";

const currentCredentials = {
  waba_id: "waba-1",
  phone_number_id: "phone-1",
  coexistence_reonboarding_status: "removed",
  coexistence_reonboarding_event: "PARTNER_REMOVED",
  coexistence_reonboarding_removed_at: "2026-08-20T08:00:00.000Z",
};

function createSourceQuery(source: unknown) {
  const maybeSingle = jest
    .fn()
    .mockResolvedValue({ data: source, error: null });
  const eqSource = jest.fn().mockReturnValue({ maybeSingle });
  const eqType = jest.fn().mockReturnValue({ eq: eqSource });
  const eqWorkspace = jest.fn().mockReturnValue({ eq: eqType });
  const select = jest.fn().mockReturnValue({ eq: eqWorkspace });
  return { select };
}

function dismissRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/reconnect-status", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/whatsapp/reconnect-status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const sourceQuery = createSourceQuery({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "whatsapp",
      credentials: currentCredentials,
    });
    mockGetMembership.mockResolvedValue({
      membership: { role: "admin" },
      user: { id: "user-1" },
      supabase: {
        from: jest.fn().mockReturnValue(sourceQuery),
      },
    });
    mockUpdateCredentials.mockImplementation(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials(currentCredentials),
    }));
  });

  it("persists an admin dismissal for the current removal incident", async () => {
    const PATCH = (
      reconnectStatusRoute as typeof reconnectStatusRoute & {
        PATCH?: (request: Request) => Promise<Response>;
      }
    ).PATCH;

    expect(typeof PATCH).toBe("function");
    if (!PATCH) return;

    const response = await PATCH(
      dismissRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        removedAt: "2026-08-20T08:00:00.000Z",
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      acknowledged: true,
      sourceId: "source-1",
      removedAt: "2026-08-20T08:00:00.000Z",
    });
    expect(mockUpdateCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        expectedWabaId: "waba-1",
        expectedCredentials: {
          coexistence_reonboarding_status: "removed",
          coexistence_reonboarding_event: "PARTNER_REMOVED",
          coexistence_reonboarding_removed_at: "2026-08-20T08:00:00.000Z",
        },
      })
    );
    const mutation = mockUpdateCredentials.mock.calls[0][0];
    expect(mutation.buildCredentials(currentCredentials)).toEqual(
      expect.objectContaining({
        partner_removed_alert_dismissed_for: "2026-08-20T08:00:00.000Z",
        partner_removed_alert_dismissed_at: expect.any(String),
        partner_removed_alert_dismissed_by: "user-1",
      })
    );
  });

  it("lets a manager acknowledge the alert for everyone", async () => {
    const sourceQuery = createSourceQuery({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "whatsapp",
      credentials: currentCredentials,
    });
    mockGetMembership.mockResolvedValue({
      membership: { role: "manager" },
      user: { id: "user-2" },
      supabase: { from: jest.fn().mockReturnValue(sourceQuery) },
    });

    const response = await reconnectStatusRoute.PATCH(
      dismissRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        removedAt: "2026-08-20T08:00:00.000Z",
      })
    );

    expect(response.status).toBe(200);
    const mutation = mockUpdateCredentials.mock.calls[0][0];
    expect(mutation.buildCredentials(currentCredentials)).toEqual(
      expect.objectContaining({ partner_removed_alert_dismissed_by: "user-2" })
    );
  });

  it.each(["owner", "member", null])(
    "rejects the unknown role %p from acknowledging alerts for everyone",
    async role => {
      const sourceQuery = createSourceQuery({
        id: "source-1",
        workspace_id: "workspace-1",
        type: "whatsapp",
        credentials: currentCredentials,
      });
      mockGetMembership.mockResolvedValue({
        membership: { role },
        user: { id: "user-2" },
        supabase: { from: jest.fn().mockReturnValue(sourceQuery) },
      });

      const response = await reconnectStatusRoute.PATCH(
        dismissRequest({
          workspaceId: "workspace-1",
          sourceId: "source-1",
          removedAt: "2026-08-20T08:00:00.000Z",
        })
      );

      expect(response.status).toBe(403);
      expect(mockUpdateCredentials).not.toHaveBeenCalled();
    }
  );

  it("does not let a stale browser dismiss a newer removal incident", async () => {
    const response = await reconnectStatusRoute.PATCH(
      dismissRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        removedAt: "2026-08-19T08:00:00.000Z",
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "STALE_PARTNER_REMOVAL",
    });
    expect(mockUpdateCredentials).not.toHaveBeenCalled();
  });

  it("returns a conflict when the removal changes during the fenced write", async () => {
    mockUpdateCredentials.mockRejectedValueOnce(
      new WhatsAppFlowSourceBindingFenceConflictError()
    );

    const response = await reconnectStatusRoute.PATCH(
      dismissRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        removedAt: "2026-08-20T08:00:00.000Z",
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "STALE_PARTNER_REMOVAL",
    });
  });

  it("acknowledges a legacy removal keyed by its last account event", async () => {
    const legacyCredentials = {
      waba_id: "waba-1",
      coexistence_reonboarding_status: "removed",
      coexistence_reonboarding_event: "PARTNER_REMOVED",
      coexistence_reonboarding_last_event_at: "2026-08-20T08:00:00.000Z",
    };
    const sourceQuery = createSourceQuery({
      id: "source-1",
      workspace_id: "workspace-1",
      type: "whatsapp",
      credentials: legacyCredentials,
    });
    mockGetMembership.mockResolvedValue({
      membership: { role: "admin" },
      user: { id: "user-1" },
      supabase: { from: jest.fn().mockReturnValue(sourceQuery) },
    });
    mockUpdateCredentials.mockImplementationOnce(async params => ({
      id: "source-1",
      workspaceId: "workspace-1",
      credentials: params.buildCredentials(legacyCredentials),
    }));

    const response = await reconnectStatusRoute.PATCH(
      dismissRequest({
        workspaceId: "workspace-1",
        sourceId: "source-1",
        removedAt: "2026-08-20T08:00:00.000Z",
      })
    );

    expect(response.status).toBe(200);
    expect(mockUpdateCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCredentials: expect.objectContaining({
          coexistence_reonboarding_removed_at: undefined,
          coexistence_reonboarding_last_event_at: "2026-08-20T08:00:00.000Z",
        }),
      })
    );
  });
});
