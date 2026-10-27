/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react";

import type { WhatsAppQrManagerListItem } from "@/lib/whatsapp/qr-entry-points/client";

import { useWhatsAppQrManager } from "./use-whatsapp-qr-manager";

const mockFetchEntryPoints = jest.fn();
const mockReplace = jest.fn();
let mockPathname = "/panel/w/workspace-1/messengers/whatsapp-qr";
let mockSearchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

jest.mock("@/lib/whatsapp/qr-entry-points/client", () => ({
  fetchWhatsAppQrEntryPoints: (...args: unknown[]) =>
    mockFetchEntryPoints(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

function item(entryPointId: string): WhatsAppQrManagerListItem {
  return {
    entryPointId,
    placementName: entryPointId,
    status: "ACTIVE",
    version: 1,
    updatedAt: "2026-08-12T10:00:00.000Z",
    readiness: "ready",
    reconcilePending: false,
    assignment: null,
  };
}

function success(
  items: WhatsAppQrManagerListItem[],
  nextCursor: string | null = null
) {
  return { ok: true as const, data: { items, nextCursor } };
}

describe("useWhatsAppQrManager loading boundaries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchEntryPoints.mockReset();
    mockPathname = "/panel/w/workspace-1/messengers/whatsapp-qr";
    mockSearchParams = new URLSearchParams();
  });

  it("starts with an empty initial-loading boundary", async () => {
    const initial = deferred<ReturnType<typeof success>>();
    mockFetchEntryPoints.mockReturnValueOnce(initial.promise);

    const { result } = renderHook(() =>
      useWhatsAppQrManager({ workspaceId: "workspace-1" })
    );

    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);

    await act(async () => {
      initial.resolve(success([item("entry-1")]));
      await initial.promise;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("retains committed cards while search, filter, and page requests replace them atomically", async () => {
    const search = deferred<ReturnType<typeof success>>();
    const filter = deferred<ReturnType<typeof success>>();
    const page = deferred<ReturnType<typeof success>>();
    mockFetchEntryPoints
      .mockResolvedValueOnce(success([item("entry-1")], "cursor-2"))
      .mockReturnValueOnce(search.promise)
      .mockReturnValueOnce(filter.promise)
      .mockReturnValueOnce(page.promise);

    const { result } = renderHook(() =>
      useWhatsAppQrManager({ workspaceId: "workspace-1" })
    );
    await waitFor(() =>
      expect(result.current.items).toEqual([item("entry-1")])
    );

    act(() => {
      result.current.setFilters(current => ({ ...current, query: "desk" }));
    });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.items).toEqual([item("entry-1")]);
    await act(async () => {
      search.resolve(success([item("entry-search")], "cursor-search-2"));
      await search.promise;
    });
    expect(result.current.items).toEqual([item("entry-search")]);

    act(() => {
      result.current.setFilters(current => ({
        ...current,
        facet: { kind: "status", status: "ACTIVE" },
      }));
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([item("entry-search")]);
    await act(async () => {
      filter.resolve(success([item("entry-filter")], "cursor-filter-2"));
      await filter.promise;
    });
    expect(result.current.items).toEqual([item("entry-filter")]);

    act(() => result.current.goNext());
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([item("entry-filter")]);
    await act(async () => {
      page.resolve(success([item("entry-page-2")]));
      await page.promise;
    });
    expect(result.current.items).toEqual([item("entry-page-2")]);
  });

  it("retains committed cards when a background refresh fails", async () => {
    const refresh = deferred<{
      ok: false;
      status: number;
      error: string;
    }>();
    mockFetchEntryPoints
      .mockResolvedValueOnce(success([item("entry-1")]))
      .mockReturnValueOnce(refresh.promise);

    const { result } = renderHook(() =>
      useWhatsAppQrManager({ workspaceId: "workspace-1" })
    );
    await waitFor(() =>
      expect(result.current.items).toEqual([item("entry-1")])
    );

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([item("entry-1")]);

    await act(async () => {
      refresh.resolve({ ok: false, status: 503, error: "Try again" });
      await refreshPromise;
    });
    expect(result.current.items).toEqual([item("entry-1")]);
    expect(result.current.error).toBe("Try again");
  });

  it("clears committed cards immediately when the workspace owner changes", async () => {
    const nextWorkspace = deferred<ReturnType<typeof success>>();
    mockFetchEntryPoints
      .mockResolvedValueOnce(success([item("entry-1")]))
      .mockReturnValueOnce(nextWorkspace.promise);

    const { result, rerender } = renderHook(
      ({ workspaceId }) => useWhatsAppQrManager({ workspaceId }),
      { initialProps: { workspaceId: "workspace-1" } }
    );
    await waitFor(() =>
      expect(result.current.items).toEqual([item("entry-1")])
    );

    mockPathname = "/panel/w/workspace-2/messengers/whatsapp-qr";
    rerender({ workspaceId: "workspace-2" });

    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);

    await act(async () => {
      nextWorkspace.resolve(success([item("entry-2")]));
      await nextWorkspace.promise;
    });
  });
});
