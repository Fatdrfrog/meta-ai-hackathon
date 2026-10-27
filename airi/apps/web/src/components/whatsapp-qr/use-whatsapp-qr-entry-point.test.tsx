/**
 * @jest-environment jsdom
 */

import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";

import type { WhatsAppQrEntryPointDetail } from "@/lib/whatsapp/qr-entry-points/client";

import { useWhatsAppQrEntryPoint } from "./use-whatsapp-qr-entry-point";

const mockCreateDraft = jest.fn();
const mockFetchDetail = jest.fn();
const mockFetchProviderCodes = jest.fn();
const mockPostCommand = jest.fn();
const mockTranslate = (
  key: string,
  values?: Record<string, string | number | Date>
) => (values?.message ? `${key}: ${values.message}` : key);

jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}));

jest.mock("@/lib/whatsapp/qr-entry-points/client", () => {
  class MockWhatsAppQrClientError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
      readonly operationId?: string
    ) {
      super(message);
    }
  }

  return {
    createWhatsAppQrDraft: (...args: unknown[]) => mockCreateDraft(...args),
    downloadWhatsAppQrArtwork: jest.fn(),
    fetchWhatsAppQrEntryPoint: (...args: unknown[]) => mockFetchDetail(...args),
    fetchWhatsAppQrProviderCodes: (...args: unknown[]) =>
      mockFetchProviderCodes(...args),
    inspectWhatsAppQrImage: jest.fn(),
    inspectWhatsAppQrUrl: jest.fn(),
    newWhatsAppQrIdempotencyKey: () => "idempotency-1",
    patchWhatsAppQrEntryPoint: jest.fn(),
    postWhatsAppQrAssignmentCommand: jest.fn(),
    postWhatsAppQrCommand: (...args: unknown[]) => mockPostCommand(...args),
    unwrapWhatsAppQrClientResult: (result: {
      ok: boolean;
      data?: unknown;
      error?: string;
      status?: number;
      code?: string;
      operationId?: string;
    }) => {
      if (result.ok) return result.data;
      throw new MockWhatsAppQrClientError(
        result.error || "Request failed",
        result.status || 500,
        result.code,
        result.operationId
      );
    },
    WhatsAppQrClientError: MockWhatsAppQrClientError,
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function detail(
  entryPointId: string,
  overrides: Partial<WhatsAppQrEntryPointDetail> = {}
): WhatsAppQrEntryPointDetail {
  return {
    entryPoint: {
      entryPointId,
      workspaceId: "workspace-1",
      placementName: entryPointId,
      status: "DRAFT",
      version: 0,
      updatedAt: "2026-08-10T10:00:00.000Z",
    },
    assignment: null,
    historicalCodes: [],
    historicalCodesHasMore: false,
    canCreateReplacement: true,
    operationPending: false,
    ...overrides,
  };
}

type OwnerCommit = {
  entryPointId: string;
  detailEntryPointId: string | null;
};

function OwnerCommitProbe({
  entryPointId,
  onCommit,
}: {
  entryPointId: string;
  onCommit: (commit: OwnerCommit) => void;
}) {
  const controller = useWhatsAppQrEntryPoint({
    workspaceId: "workspace-1",
    entryPointId,
  });

  useLayoutEffect(() => {
    onCommit({
      entryPointId,
      detailEntryPointId: controller.detail?.entryPoint.entryPointId ?? null,
    });
  }, [controller.detail, entryPointId, onCommit]);

  return null;
}

describe("useWhatsAppQrEntryPoint owner and command safety", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPostCommand.mockResolvedValue({
      ok: true,
      data: { status: "applied" },
    });
  });

  it("localizes the QR index migration gate instead of exposing the server diagnostic", async () => {
    mockCreateDraft.mockResolvedValueOnce({
      ok: false,
      status: 503,
      error: "WhatsApp QR index migration is required",
      code: "WHATSAPP_QR_INDEX_MIGRATION_REQUIRED",
    });
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: null,
      })
    );

    await act(async () => {
      await result.current.saveDraft({ placementName: "Counter" });
    });

    expect(result.current.commandError).toBe(
      "controller.errors.indexMigrationRequired"
    );
    expect(result.current.commandError).not.toContain("index migration");
  });

  it("publishes and clears only the operation that owns the mutation", async () => {
    const create = deferred<unknown>();
    mockCreateDraft.mockReturnValueOnce(create.promise);
    mockFetchDetail.mockResolvedValue({
      ok: true,
      data: detail("entry-1"),
    });
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: null,
      })
    );

    let first!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    let competing!: Promise<boolean>;
    act(() => {
      first = result.current.saveDraft({ placementName: "Counter" });
      duplicate = result.current.saveDraft({ placementName: "Counter" });
      competing = result.current.createCode({
        sourceId: "source-a",
        placementName: "Counter",
        desiredMessage: "Hello",
      });
    });

    expect(result.current.commandBusy).toBe(true);
    expect(result.current.pendingOperationKey).toBe("save-draft");
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    await expect(competing).resolves.toBe(false);

    await act(async () => {
      create.resolve({ ok: true, data: detail("entry-1") });
      await Promise.all([first, duplicate]);
    });

    expect(result.current.commandBusy).toBe(false);
    expect(result.current.pendingOperationKey).toBeNull();
  });

  it("does not keep the initiating action busy while the host refresh settles", async () => {
    const hostRefresh = deferred<void>();
    mockCreateDraft.mockResolvedValueOnce({
      ok: true,
      data: detail("entry-1"),
    });
    mockFetchDetail.mockResolvedValue({
      ok: true,
      data: detail("entry-1"),
    });
    const onMutationSettled = jest.fn(() => hostRefresh.promise);
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: null,
        onMutationSettled,
      })
    );

    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.saveDraft({ placementName: "Counter" });
    });

    await waitFor(() => expect(onMutationSettled).toHaveBeenCalledTimes(1));
    await expect(saved).resolves.toBe(true);
    expect(result.current.commandBusy).toBe(false);
    expect(result.current.pendingOperationKey).toBeNull();

    hostRefresh.resolve();
  });

  it("invalidates stale detail when the entry-point owner changes", async () => {
    const stale = deferred<unknown>();
    const secondDetail = detail("entry-2");
    mockFetchDetail
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ok: true, data: secondDetail });

    const { result, rerender } = renderHook(
      ({ entryPointId }) =>
        useWhatsAppQrEntryPoint({
          workspaceId: "workspace-1",
          entryPointId,
        }),
      { initialProps: { entryPointId: "entry-1" } }
    );

    await waitFor(() => expect(mockFetchDetail).toHaveBeenCalledTimes(1));
    rerender({ entryPointId: "entry-2" });
    expect(result.current.detail).toBeNull();
    await waitFor(() => expect(result.current.detail).toEqual(secondDetail));

    await act(async () => {
      stale.resolve({ ok: true, data: detail("entry-stale") });
      await stale.promise;
    });

    expect(result.current.detail).toEqual(secondDetail);
  });

  it("never exposes detail from the previous owner during a scope change", async () => {
    const pending = new Promise(() => {});
    mockFetchDetail
      .mockResolvedValueOnce({ ok: true, data: detail("entry-1") })
      .mockReturnValue(pending);
    const commits: OwnerCommit[] = [];
    const recordCommit = (commit: OwnerCommit) => commits.push(commit);
    const { rerender } = render(
      <OwnerCommitProbe entryPointId="entry-1" onCommit={recordCommit} />
    );

    await waitFor(() =>
      expect(commits.at(-1)?.detailEntryPointId).toBe("entry-1")
    );

    commits.length = 0;
    rerender(
      <OwnerCommitProbe entryPointId="entry-2" onCommit={recordCommit} />
    );
    expect(
      commits
        .filter(commit => commit.entryPointId === "entry-2")
        .every(commit => commit.detailEntryPointId === null)
    ).toBe(true);

    commits.length = 0;
    rerender(
      <OwnerCommitProbe entryPointId="entry-1" onCommit={recordCommit} />
    );
    expect(
      commits
        .filter(commit => commit.entryPointId === "entry-1")
        .every(commit => commit.detailEntryPointId === null)
    ).toBe(true);
  });

  it("invalidates an old detail request across an owner round trip", async () => {
    const stale = deferred<unknown>();
    const pending = new Promise(() => {});
    mockFetchDetail.mockReturnValueOnce(stale.promise).mockReturnValue(pending);

    const { result, rerender } = renderHook(
      ({ ownerKey }) =>
        useWhatsAppQrEntryPoint({
          workspaceId: "workspace-1",
          entryPointId: "entry-1",
          ownerKey,
        }),
      { initialProps: { ownerKey: "owner-a" } }
    );

    await waitFor(() => expect(mockFetchDetail).toHaveBeenCalledTimes(1));
    rerender({ ownerKey: "owner-b" });
    rerender({ ownerKey: "owner-a" });

    await act(async () => {
      stale.resolve({ ok: true, data: detail("entry-stale") });
      await stale.promise;
    });

    expect(result.current.detail).toBeNull();
  });

  it("cancels a create mutation when its owner changes", async () => {
    const create = deferred<unknown>();
    mockCreateDraft.mockReturnValueOnce(create.promise);
    const { result, rerender } = renderHook(
      ({ ownerKey }) =>
        useWhatsAppQrEntryPoint({
          workspaceId: "workspace-1",
          entryPointId: null,
          ownerKey,
        }),
      { initialProps: { ownerKey: "owner-a" } }
    );

    let createPromise!: Promise<boolean>;
    act(() => {
      createPromise = result.current.createCode({
        sourceId: "source-a",
        placementName: "Counter",
        desiredMessage: "Hello",
      });
    });
    await waitFor(() => expect(mockCreateDraft).toHaveBeenCalledTimes(1));

    rerender({ ownerKey: "owner-b" });
    rerender({ ownerKey: "owner-a" });
    await act(async () => {
      create.resolve({ ok: true, data: detail("entry-stale") });
      await createPromise;
    });

    expect(mockPostCommand).not.toHaveBeenCalled();
    expect(result.current.detail).toBeNull();
    expect(result.current.commandBusy).toBe(false);
  });

  it("ignores provider-code responses from a previously selected source", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockFetchProviderCodes
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: null,
      })
    );

    act(() => {
      void result.current.loadProviderCodes("source-a");
      void result.current.loadProviderCodes("source-b");
    });

    await act(async () => {
      second.resolve({
        ok: true,
        data: {
          codes: [{ code: "B", deepLink: "https://wa.me/message/B" }],
        },
      });
      await second.promise;
    });
    await act(async () => {
      first.resolve({
        ok: true,
        data: {
          codes: [{ code: "A", deepLink: "https://wa.me/message/A" }],
        },
      });
      await first.promise;
    });

    expect(result.current.providerCodes).toEqual([
      expect.objectContaining({ code: "B" }),
    ]);
    expect(result.current.providerCodesLoading).toBe(false);
  });

  it("retains the committed provider page while a same-source page loads", async () => {
    const nextPage = deferred<unknown>();
    mockFetchProviderCodes
      .mockResolvedValueOnce({
        ok: true,
        data: {
          codes: [{ code: "A", deepLink: "https://wa.me/message/A" }],
          nextCursor: "cursor-b",
        },
      })
      .mockReturnValueOnce(nextPage.promise);
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: null,
      })
    );

    await act(async () => {
      await result.current.loadProviderCodes("source-a");
    });
    act(() => {
      void result.current.goToNextProviderCodesPage();
    });

    expect(result.current.providerCodesLoading).toBe(true);
    expect(result.current.providerCodes).toEqual([
      expect.objectContaining({ code: "A" }),
    ]);

    await act(async () => {
      nextPage.resolve({
        ok: true,
        data: {
          codes: [{ code: "B", deepLink: "https://wa.me/message/B" }],
        },
      });
      await nextPage.promise;
    });

    expect(result.current.providerCodes).toEqual([
      expect.objectContaining({ code: "B" }),
    ]);
  });

  it("targets the selected historical code for routing and deletion", async () => {
    const entryPointDetail = detail("entry-1", {
      entryPoint: {
        entryPointId: "entry-1",
        workspaceId: "workspace-1",
        placementName: "Counter",
        sourceId: "source-a",
        currentCodeId: "code-current",
        status: "ACTIVE",
        version: 4,
        updatedAt: "2026-08-10T10:00:00.000Z",
      },
      currentCode: {
        codeId: "code-current",
        referenceCode: "CURRENT123",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 2,
      },
      historicalCodes: [
        {
          codeId: "code-old",
          referenceCode: "OLDREF1234",
          placementBindingState: "HISTORICAL",
          routingState: "ENABLED",
          providerState: "ACTIVE",
          version: 7,
        },
      ],
    });
    mockFetchDetail.mockResolvedValue({ ok: true, data: entryPointDetail });
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
      })
    );
    await waitFor(() =>
      expect(result.current.detail).toEqual(entryPointDetail)
    );

    await act(async () => {
      await result.current.setRouting("code-old", "DISABLED");
    });
    expect(mockPostCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          command: "set_routing",
          codeId: "code-old",
          expectedCodeVersion: 7,
          expectedEntryPointVersion: 4,
          routingState: "DISABLED",
        }),
      })
    );

    await act(async () => {
      await result.current.deleteFromMeta("code-old");
    });
    expect(mockPostCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          command: "delete",
          codeId: "code-old",
          expectedCodeVersion: 7,
          expectedEntryPointVersion: 4,
          confirmed: true,
        }),
      })
    );
  });

  it("reconciles with the operation's persisted source binding", async () => {
    const entryPointDetail = detail("entry-1", {
      reconcileOperation: {
        operationId: "operation-create",
        sourceId: "source-b",
        kind: "CREATE",
      },
    });
    mockFetchDetail.mockResolvedValue({ ok: true, data: entryPointDetail });
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
      })
    );
    await waitFor(() =>
      expect(result.current.detail).toEqual(entryPointDetail)
    );

    await act(async () => {
      await result.current.reconcileOperation("operation-create");
    });

    expect(mockPostCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          command: "reconcile",
          workspaceId: "workspace-1",
          sourceId: "source-b",
          entryPointId: "entry-1",
          operationId: "operation-create",
        },
      })
    );
  });

  it("checks the exact current provider code with current resource versions", async () => {
    const entryPointDetail = detail("entry-1", {
      entryPoint: {
        entryPointId: "entry-1",
        workspaceId: "workspace-1",
        placementName: "Counter",
        sourceId: "source-a",
        currentCodeId: "code-current",
        status: "ACTIVE",
        version: 4,
        updatedAt: "2026-08-10T10:00:00.000Z",
      },
      currentCode: {
        codeId: "code-current",
        referenceCode: "CURRENT123",
        placementBindingState: "CURRENT",
        routingState: "ENABLED",
        providerState: "ACTIVE",
        version: 7,
      },
    });
    mockFetchDetail.mockResolvedValue({ ok: true, data: entryPointDetail });
    const { result } = renderHook(() =>
      useWhatsAppQrEntryPoint({
        workspaceId: "workspace-1",
        entryPointId: "entry-1",
      })
    );
    await waitFor(() =>
      expect(result.current.detail).toEqual(entryPointDetail)
    );

    await act(async () => {
      await result.current.checkProvider();
    });

    expect(mockPostCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          command: "check_provider",
          workspaceId: "workspace-1",
          sourceId: "source-a",
          entryPointId: "entry-1",
          expectedEntryPointVersion: 4,
          expectedCodeVersion: 7,
        },
      })
    );
    expect(result.current.statusMessage).toBe(
      "controller.status.providerChecked"
    );
  });
});
