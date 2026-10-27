/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { WhatsAppFlowConfig } from "@icecore/scenario-contracts";
import type { ManagedWhatsAppFlowProvisioningHost } from "./managed-provisioning-host";
import { useFlowBuilderLifecycle } from "./use-flow-builder-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const config: WhatsAppFlowConfig = {
  templateId: "appointment_booking",
  ctaText: "Book",
  flowNavigationMode: "linear",
  screens: [{ id: "DETAILS", title: "Details", fields: [] }],
};

function host(
  overrides: Partial<ManagedWhatsAppFlowProvisioningHost> = {}
): ManagedWhatsAppFlowProvisioningHost {
  return {
    ownerKey: "scenario:a:visit:1",
    sources: [{ id: "source-1", label: "Primary" }],
    publishing: false,
    publish: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const t = (key: string) => key;

describe("useFlowBuilderLifecycle ownership", () => {
  it("ignores a retained selection command after an A-B-A owner transition", async () => {
    const select = jest.fn();
    const firstHost = host();
    const { result, rerender } = renderHook(
      ({ managedHost }) =>
        useFlowBuilderLifecycle({
          flowConfig: null,
          commitFlowConfig: jest.fn(),
          workspaceId: "workspace-1",
          host: managedHost,
          onSelectExistingFlow: select,
          t,
        }),
      { initialProps: { managedHost: firstHost } }
    );
    const retained = result.current.selectExistingFlow;
    rerender({ managedHost: host({ ownerKey: "scenario:b:visit:1" }) });
    rerender({ managedHost: firstHost });

    await act(async () => {
      await retained({ id: "flow-1", name: "Flow", sourceId: "source-1" });
    });

    expect(select).not.toHaveBeenCalled();
  });

  it("suppresses a stale publish error after the workspace owner changes", async () => {
    const pending = deferred<null>();
    const firstHost = host({
      publish: jest.fn().mockReturnValue(pending.promise),
    });
    const { result, rerender } = renderHook(
      ({ workspaceId, managedHost }) =>
        useFlowBuilderLifecycle({
          flowConfig: config,
          commitFlowConfig: jest.fn(),
          workspaceId,
          host: managedHost,
          t,
        }),
      {
        initialProps: { workspaceId: "workspace-1", managedHost: firstHost },
      }
    );
    await act(async () => {
      void result.current.publish();
    });
    rerender({
      workspaceId: "workspace-2",
      managedHost: host({ ownerKey: "scenario:b:visit:1" }),
    });
    await act(async () => {
      pending.reject(new Error("old workspace failure"));
      try {
        await pending.promise;
      } catch {}
    });

    expect(result.current.saveState).toBe("idle");
    expect(result.current.saveError).toBeNull();
  });

  it("turns a null host rejection into a safe generic error", async () => {
    const managedHost = host({
      publish: jest.fn().mockRejectedValue(null),
    });
    const { result } = renderHook(() =>
      useFlowBuilderLifecycle({
        flowConfig: config,
        commitFlowConfig: jest.fn(),
        workspaceId: "workspace-1",
        host: managedHost,
        t,
      })
    );

    await act(async () => {
      await result.current.publish();
    });

    expect(result.current.saveState).toBe("error");
    expect(result.current.saveError).toBe("flowSaveFailed");
    expect(result.current.saveIssueLines).toEqual([]);
  });

  it("reflects a durable host publication after remount", () => {
    const managedHost = host({ publishing: true });
    const { result } = renderHook(() =>
      useFlowBuilderLifecycle({
        flowConfig: config,
        commitFlowConfig: jest.fn(),
        workspaceId: "workspace-1",
        host: managedHost,
        t,
      })
    );

    expect(result.current.publishing).toBe(true);
  });

  it("keeps the current publication presentation when adoption adds a managed Flow id", async () => {
    const publication =
      deferred<
        Awaited<ReturnType<ManagedWhatsAppFlowProvisioningHost["publish"]>>
      >();
    const managedHost = host({
      publish: jest.fn().mockReturnValue(publication.promise),
    });
    const onFlowArtifactsChanged = jest.fn();
    const { result, rerender } = renderHook(
      ({ flowConfig }) =>
        useFlowBuilderLifecycle({
          flowConfig,
          commitFlowConfig: jest.fn(),
          workspaceId: "workspace-1",
          host: managedHost,
          onFlowArtifactsChanged,
          t,
        }),
      { initialProps: { flowConfig: config } }
    );
    await act(async () => {
      void result.current.publish();
    });
    rerender({
      flowConfig: {
        ...config,
        managedProvisioning: {
          operationId: "operation-1",
          sourceId: "source-1",
          wabaId: "waba-1",
          contentRevision: 1,
          contentDigest: "a".repeat(64),
          flowId: "flow-1",
          providerStatus: "PUBLISHED",
        },
      },
    });
    await act(async () => {
      publication.resolve({
        response: {
          ok: true,
          status: 200,
          data: {
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
              finalUpdatedAt: "2026-09-18T10:00:00.000Z",
            },
            phones: [],
            validationErrors: [],
          },
        },
        adopted: true,
      });
      await publication.promise;
    });

    expect(result.current.saveState).toBe("saved");
    expect(onFlowArtifactsChanged).toHaveBeenCalledTimes(1);
  });
});
