"use client";

import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  fetchWhatsAppQrEntryPoints,
  type WhatsAppQrManagerListItem,
} from "@/lib/whatsapp/qr-entry-points/client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

import { useOwnerBoundState } from "./owner-bound-state";

const SEARCH_DEBOUNCE_MS = 250;
const CURSOR_HISTORY_LIMIT = 20;
const DEFAULT_PAGE_SIZE = 12;

const STATUS_VALUES = new Set(["DRAFT", "ACTIVE", "DETACHED"] as const);
const ASSIGNMENT_VALUES = new Set(["assigned", "unassigned"] as const);

export type WhatsAppQrManagerFilters = {
  query: string;
  facet:
    | { kind: "all" }
    | { kind: "source"; sourceId: string }
    | { kind: "status"; status: "DRAFT" | "ACTIVE" | "DETACHED" }
    | { kind: "assignment"; assignment: "assigned" | "unassigned" };
};

type ManagerState = {
  items: WhatsAppQrManagerListItem[];
  hasCommittedPage: boolean;
  filters: WhatsAppQrManagerFilters;
  requestFilters: WhatsAppQrManagerFilters;
  cursor: string | null;
  cursorHistory: Array<string | null>;
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
};

export type WhatsAppQrManagerController = {
  items: WhatsAppQrManagerListItem[];
  hasCommittedPage: boolean;
  filters: WhatsAppQrManagerFilters;
  setFilters: Dispatch<SetStateAction<WhatsAppQrManagerFilters>>;
  loading: boolean;
  error: string | null;
  canGoPrevious: boolean;
  canGoNext: boolean;
  goPrevious(): void;
  goNext(): void;
  refresh(): Promise<void>;
};

export function normalizeWhatsAppQrManagerQuery(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 512);
}

function normalizeFacet(
  facet: WhatsAppQrManagerFilters["facet"]
): WhatsAppQrManagerFilters["facet"] {
  if (facet.kind === "source") {
    const sourceId = facet.sourceId.trim();
    return sourceId ? { kind: "source", sourceId } : { kind: "all" };
  }
  if (facet.kind === "status" && STATUS_VALUES.has(facet.status)) {
    return facet;
  }
  if (facet.kind === "assignment" && ASSIGNMENT_VALUES.has(facet.assignment)) {
    return facet;
  }
  return { kind: "all" };
}

function normalizeFilters(
  filters: WhatsAppQrManagerFilters
): WhatsAppQrManagerFilters {
  return {
    query: normalizeWhatsAppQrManagerQuery(filters.query),
    facet: normalizeFacet(filters.facet),
  };
}

function parseFilters(searchParams: URLSearchParams): WhatsAppQrManagerFilters {
  const query = normalizeWhatsAppQrManagerQuery(
    searchParams.get("query") || ""
  );
  const facet = searchParams.get("facet");
  const value = searchParams.get("value")?.trim() || "";

  if (facet === "source" && value) {
    return { query, facet: { kind: "source", sourceId: value } };
  }
  if (facet === "status" && STATUS_VALUES.has(value as never)) {
    return {
      query,
      facet: {
        kind: "status",
        status: value as "DRAFT" | "ACTIVE" | "DETACHED",
      },
    };
  }
  if (facet === "assignment" && ASSIGNMENT_VALUES.has(value as never)) {
    return {
      query,
      facet: {
        kind: "assignment",
        assignment: value as "assigned" | "unassigned",
      },
    };
  }
  return { query, facet: { kind: "all" } };
}

function sameFacet(
  left: WhatsAppQrManagerFilters["facet"],
  right: WhatsAppQrManagerFilters["facet"]
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "all" || right.kind === "all") return true;
  if (left.kind === "source" && right.kind === "source") {
    return left.sourceId === right.sourceId;
  }
  if (left.kind === "status" && right.kind === "status") {
    return left.status === right.status;
  }
  return (
    left.kind === "assignment" &&
    right.kind === "assignment" &&
    left.assignment === right.assignment
  );
}

function sameFilters(
  left: WhatsAppQrManagerFilters,
  right: WhatsAppQrManagerFilters
): boolean {
  return left.query === right.query && sameFacet(left.facet, right.facet);
}

function serializeFilters(filters: WhatsAppQrManagerFilters): URLSearchParams {
  const params = new URLSearchParams();
  const query = filters.query.trim();
  if (query) params.set("query", query);
  if (filters.facet.kind !== "all") {
    params.set("facet", filters.facet.kind);
    params.set(
      "value",
      filters.facet.kind === "source"
        ? filters.facet.sourceId
        : filters.facet.kind === "status"
          ? filters.facet.status
          : filters.facet.assignment
    );
  }
  return params;
}

function createInitialState(filters: WhatsAppQrManagerFilters): ManagerState {
  return {
    items: [],
    hasCommittedPage: false,
    filters,
    requestFilters: filters,
    cursor: null,
    cursorHistory: [],
    nextCursor: null,
    loading: true,
    error: null,
  };
}

function toClientFacet(filters: WhatsAppQrManagerFilters) {
  return filters.facet.kind === "all" ? undefined : filters.facet;
}

export function useWhatsAppQrManager({
  workspaceId,
  pageSize = DEFAULT_PAGE_SIZE,
}: {
  workspaceId: string;
  pageSize?: number;
}): WhatsAppQrManagerController {
  const normalizedWorkspaceId = workspaceId.trim();
  const boundedPageSize = Math.max(1, Math.min(50, Math.trunc(pageSize)));
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlSearch = searchParams.toString();
  const ownerKey = useTransitionOwnerKey(normalizedWorkspaceId);
  const initialFilters = useMemo(
    () => parseFilters(new URLSearchParams(urlSearch)),
    // The complete owner-bound store is recreated for workspace changes. URL
    // changes are reconciled below so committed cards can remain visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownerKey]
  );
  const createInitial = useCallback(
    () => createInitialState(initialFilters),
    [initialFilters]
  );
  const [state, setState] = useOwnerBoundState(ownerKey, createInitial);
  const stateRef = useLatestRef(state);
  const ownerKeyRef = useLatestRef(ownerKey);

  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const lastWrittenSearchRef = useRef<string | null>(null);

  const replaceUrl = useCallback(
    (filters: WhatsAppQrManagerFilters) => {
      const params = serializeFilters(filters);
      const nextSearch = params.toString();
      lastWrittenSearchRef.current = nextSearch;
      router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router]
  );

  const requestPage = useCallback(
    async (input: {
      filters: WhatsAppQrManagerFilters;
      cursor: string | null;
      expectedOwner: string;
    }): Promise<void> => {
      const requestSequence = ++requestSequenceRef.current;
      abortRef.current?.abort();
      const abortController = new AbortController();
      abortRef.current = abortController;

      setState(current => ({
        ...current,
        loading: true,
        error: null,
      }));

      const result = await fetchWhatsAppQrEntryPoints({
        workspaceId: normalizedWorkspaceId,
        query: input.filters.query.trim() || undefined,
        facet: toClientFacet(input.filters),
        cursor: input.cursor || undefined,
        limit: boundedPageSize,
        signal: abortController.signal,
      });

      if (
        abortController.signal.aborted ||
        requestSequence !== requestSequenceRef.current ||
        ownerKeyRef.current !== input.expectedOwner
      ) {
        return;
      }

      if (!result.ok) {
        setState(current => ({
          ...current,
          loading: false,
          error: result.error,
        }));
        return;
      }

      setState(current => ({
        ...current,
        items: result.data.items,
        hasCommittedPage: true,
        nextCursor: result.data.nextCursor,
        loading: false,
        error: null,
      }));
    },
    [boundedPageSize, normalizedWorkspaceId, ownerKeyRef, setState]
  );

  const requestKey = useMemo(
    () =>
      JSON.stringify({
        filters: state.requestFilters,
        cursor: state.cursor,
      }),
    [state.cursor, state.requestFilters]
  );

  useEffect(() => {
    const current = stateRef.current;
    void requestPage({
      filters: current.requestFilters,
      cursor: current.cursor,
      expectedOwner: ownerKey,
    });
    return () => abortRef.current?.abort();
  }, [ownerKey, requestKey, requestPage, stateRef]);

  useEffect(() => {
    if (lastWrittenSearchRef.current === urlSearch) {
      lastWrittenSearchRef.current = null;
      return;
    }

    const nextFilters = parseFilters(new URLSearchParams(urlSearch));
    const current = stateRef.current;
    if (
      sameFilters(current.filters, nextFilters) &&
      sameFilters(current.requestFilters, nextFilters)
    ) {
      return;
    }

    setState(previous => ({
      ...previous,
      filters: nextFilters,
      requestFilters: nextFilters,
      cursor: null,
      cursorHistory: [],
      nextCursor: null,
      loading: true,
      error: null,
    }));
  }, [ownerKey, setState, stateRef, urlSearch]);

  useEffect(() => {
    const current = stateRef.current;
    if (current.filters.query === current.requestFilters.query) return;

    const timeout = window.setTimeout(() => {
      if (ownerKeyRef.current !== ownerKey) return;
      const latest = stateRef.current;
      const nextRequestFilters = {
        ...latest.requestFilters,
        query: latest.filters.query,
      };
      setState(previous => ({
        ...previous,
        requestFilters: nextRequestFilters,
        cursor: null,
        cursorHistory: [],
        nextCursor: null,
        loading: true,
        error: null,
      }));
      replaceUrl(nextRequestFilters);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [
    ownerKey,
    ownerKeyRef,
    replaceUrl,
    setState,
    state.filters.query,
    stateRef,
  ]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      requestSequenceRef.current += 1;
    };
  }, [ownerKey]);

  const setFilters = useCallback<
    Dispatch<SetStateAction<WhatsAppQrManagerFilters>>
  >(
    nextValue => {
      const current = stateRef.current;
      const resolved = normalizeFilters(
        typeof nextValue === "function" ? nextValue(current.filters) : nextValue
      );
      if (sameFilters(current.filters, resolved)) return;

      const facetChanged = !sameFacet(current.filters.facet, resolved.facet);
      const clearedQuery =
        current.filters.query.length > 0 && resolved.query.length === 0;
      const commitImmediately = facetChanged || clearedQuery;
      const nextRequestFilters = commitImmediately
        ? resolved
        : current.requestFilters;

      setState(previous => ({
        ...previous,
        filters: resolved,
        ...(commitImmediately
          ? {
              requestFilters: nextRequestFilters,
              cursor: null,
              cursorHistory: [],
              nextCursor: null,
              loading: true,
              error: null,
            }
          : {}),
      }));
      if (commitImmediately) replaceUrl(nextRequestFilters);
    },
    [replaceUrl, setState, stateRef]
  );

  const goPrevious = useCallback(() => {
    const current = stateRef.current;
    if (current.cursorHistory.length === 0 || current.loading) return;
    const history = current.cursorHistory.slice(0, -1);
    const cursor = current.cursorHistory.at(-1) ?? null;
    setState(previous => ({
      ...previous,
      cursor,
      cursorHistory: history,
      nextCursor: null,
      loading: true,
      error: null,
    }));
  }, [setState, stateRef]);

  const goNext = useCallback(() => {
    const current = stateRef.current;
    if (!current.nextCursor || current.loading) return;
    const history = [...current.cursorHistory, current.cursor].slice(
      -CURSOR_HISTORY_LIMIT
    );
    setState(previous => ({
      ...previous,
      cursor: current.nextCursor,
      cursorHistory: history,
      nextCursor: null,
      loading: true,
      error: null,
    }));
  }, [setState, stateRef]);

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    await requestPage({
      filters: current.requestFilters,
      cursor: current.cursor,
      expectedOwner: ownerKey,
    });
  }, [ownerKey, requestPage, stateRef]);

  return {
    items: state.items,
    hasCommittedPage: state.hasCommittedPage,
    filters: state.filters,
    setFilters,
    loading: state.loading,
    error: state.error,
    canGoPrevious: state.cursorHistory.length > 0,
    canGoNext: Boolean(state.nextCursor),
    goPrevious,
    goNext,
    refresh,
  };
}
