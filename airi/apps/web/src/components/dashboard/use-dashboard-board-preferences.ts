"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  dashboardBoardStateSchema,
  normalizeStoredDashboardBoard,
  type DashboardBoardState,
} from "./dashboard-board-model";
import {
  parseDashboardRecommendation,
  type DashboardRecommendation,
} from "@/lib/analytics/dashboard-recommendation";

export type BoardPreferences = {
  state: DashboardBoardState | null;
  revision: number | null;
  /** A stored layout exists at `revision` but this release cannot read it. */
  unreadable?: boolean;
  /** Starting dashboard suggested for members without a saved layout. */
  recommendation?: DashboardRecommendation | null;
};
export type BoardDraft = {
  state: DashboardBoardState;
  revision: number | null;
};

class BoardRequestError extends Error {
  constructor(readonly status: number) {
    super("Dashboard preferences request failed");
  }
}

async function requestPreferences(
  url: string,
  options?: RequestInit
): Promise<BoardPreferences> {
  const response = await fetch(url, options);
  if (!response.ok) throw new BoardRequestError(response.status);
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("state" in body) ||
    !("revision" in body)
  ) {
    throw new Error("Invalid dashboard preferences");
  }
  const { state, revision } = body;
  const recommendation =
    "recommendation" in body
      ? parseDashboardRecommendation(body.recommendation)
      : null;
  if (state === null && revision === null)
    return { state: null, revision: null, recommendation };
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("Invalid dashboard revision");
  }
  // Read leniently: an unreadable stored layout keeps its revision so an
  // explicit save can replace it, instead of locking the member out.
  const normalized = normalizeStoredDashboardBoard(state);
  return normalized
    ? { state: normalized, revision, recommendation }
    : { state: null, revision, unreadable: true, recommendation };
}

/**
 * The existing controller coupled this persistence flow to named dashboard views.
 * Both personal surfaces now compose this owner so validation, revisions and
 * conflict recovery cannot diverge while their layout controls remain separate.
 */
export function useDashboardBoardPreferences(
  workspaceId: string,
  memberId: string
) {
  const endpoint = `/api/workspaces/${workspaceId}/analytics/dashboards`;
  const { data, error, isLoading, mutate } = useSWR<BoardPreferences>(
    [endpoint, memberId],
    ([url]: [string, string]) => requestPreferences(url),
    // Boards render read-only defaults meanwhile, so a brief outage may retry.
    { revalidateOnFocus: false, errorRetryCount: 2 }
  );
  const [draft, setDraft] = useState<BoardDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<
    "saveFailed" | "conflict" | "reloadFailed" | "invalidLayout" | null
  >(null);
  const [conflicted, setConflicted] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function cancel() {
    setDraft(null);
    setSaveError(null);
    setConflicted(false);
  }

  async function save(): Promise<BoardPreferences | null> {
    if (!draft || inFlight.current || conflicted) return null;
    const parsed = dashboardBoardStateSchema.safeParse(draft.state);
    if (!parsed.success) {
      setSaveError("invalidLayout");
      return null;
    }
    inFlight.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      const saved = await requestPreferences(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: parsed.data, revision: draft.revision }),
      });
      if (!saved.state) throw new Error("Save returned no dashboard state");
      // Saves do not recompute the workspace recommendation; keep the read one.
      const result = {
        ...saved,
        recommendation: data?.recommendation ?? null,
      };
      if (!mounted.current) return null;
      await mutate(result, { revalidate: false });
      if (!mounted.current) return null;
      setDraft(null);
      return result;
    } catch (failure) {
      if (!mounted.current) return null;
      const conflict =
        failure instanceof BoardRequestError && failure.status === 409;
      setConflicted(conflict);
      setSaveError(conflict ? "conflict" : "saveFailed");
      return null;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function reloadSaved(): Promise<BoardPreferences | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await requestPreferences(endpoint);
      if (!mounted.current) return null;
      await mutate(result, { revalidate: false });
      if (!mounted.current) return null;
      cancel();
      return result;
    } catch {
      if (mounted.current) setSaveError("reloadFailed");
      return null;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return {
    data,
    error,
    isLoading,
    mutate,
    draft,
    setDraft,
    busy,
    saveError,
    setSaveError,
    conflicted,
    cancel,
    save,
    reloadSaved,
  };
}
