"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  createDashboardView,
  createDashboardCard,
  createDefaultDashboardBoard,
  createDefaultOutcomesBoard,
  createOutcomesCard,
  OUTCOMES_BLOCK_IDS,
  type OutcomesBlockId,
  type OutcomesBoardCard,
  type AnalyticsBoardCard,
  dashboardBoardStateSchema,
  DASHBOARD_CARD_IDS,
  DASHBOARD_CARD_DEFINITIONS,
  DASHBOARD_CARD_GROUPS,
  DASHBOARD_MAX_VIEWS,
  DASHBOARD_TEMPLATES,
  type DashboardBoardCard,
  type DashboardBoardState,
  type DashboardCardId,
  type DashboardTemplateId,
} from "./dashboard-board-model";
import {
  useDashboardBoardMemory,
  writeDashboardBoardMemory,
} from "./dashboard-board-memory";

import {
  useDashboardBoardPreferences,
  type BoardDraft,
  type BoardPreferences,
} from "./use-dashboard-board-preferences";

/** Default board for a member without a saved layout: the recommended template. */
function startingTemplate(data: BoardPreferences | undefined) {
  return data?.recommendation?.templateId ?? "starter";
}

export type DashboardBoardPresentation<
  CardId extends string = DashboardCardId,
> = {
  cards: AnalyticsBoardCard<CardId>[];
  editing: boolean;
  onCardsChange: (cards: AnalyticsBoardCard<CardId>[]) => void;
};

type ControllerProps = {
  workspaceId: string;
  memberId: string;
  children: (presentation: DashboardBoardPresentation) => ReactNode;
};

export type OutcomesBoardPresentation =
  DashboardBoardPresentation<OutcomesBlockId> & {
    toolbar: ReactNode;
  };
type OutcomesControllerProps = Omit<ControllerProps, "children"> & {
  children: (presentation: OutcomesBoardPresentation) => ReactNode;
  inlineToolbar?: boolean;
};

/** The Outcomes canvas shares the personal preference record, not dashboard views. */
export function OutcomesBoardController(props: OutcomesControllerProps) {
  return (
    <WorkspaceOutcomesBoardController
      key={`${props.workspaceId}:${props.memberId}`}
      {...props}
    />
  );
}

function WorkspaceOutcomesBoardController({
  workspaceId,
  memberId,
  children,
  inlineToolbar = false,
}: OutcomesControllerProps) {
  const t = useTranslations("AnalyticsOutcomes.workspace");
  const reports = useTranslations("AnalyticsOutcomes.tabs");
  const common = useTranslations("DashboardClientPage.board");
  const {
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
  } = useDashboardBoardPreferences(workspaceId, memberId);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [added, setAdded] = useState<OutcomesBlockId | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const libraryOptions = useRef<HTMLDivElement | null>(null);
  const libraryClose = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const template = startingTemplate(data);
  const fallback = createDefaultDashboardBoard(
    template,
    common(`templates.${template}.title`)
  );
  const saved = data?.state ?? fallback;
  const board = draft?.state ?? saved;
  const cards = board.outcomes?.cards ?? createDefaultOutcomesBoard().cards;
  const showInlineToolbar = inlineToolbar && cards.length > 0;
  const editing = draft !== null;
  const validDraft =
    !draft || dashboardBoardStateSchema.safeParse(draft.state).success;
  const missing = OUTCOMES_BLOCK_IDS.filter(
    id => !cards.some(card => card.id === id)
  );

  function beginEdit() {
    // An unavailable/corrupt preference may render reports, but never become writable.
    if (!data || busy) return;
    setDraft({
      state: {
        ...saved,
        outcomes: { cards: cards.map(card => ({ ...card })) },
      },
      revision: data.revision,
    });
    setSaveError(null);
  }

  function changeCards(nextCards: OutcomesBoardCard[]) {
    if (!editing || busy) return;
    setDraft(current =>
      current
        ? {
            ...current,
            state: { ...current.state, outcomes: { cards: nextCards } },
          }
        : current
    );
  }

  function addReport(id: OutcomesBlockId) {
    if (busy) return;
    setDraft(current => {
      if (!current) return current;
      const currentCards = current.state.outcomes?.cards ?? [];
      if (currentCards.some(card => card.id === id)) return current;
      return {
        ...current,
        state: {
          ...current.state,
          outcomes: { cards: [...currentCards, createOutcomesCard(id)] },
        },
      };
    });
    setAdded(id);
    requestAnimationFrame(() => {
      const nextOption =
        libraryOptions.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)"
        );
      (nextOption ?? libraryClose.current)?.focus();
    });
  }

  function restoreEditFocus() {
    requestAnimationFrame(() => editButton.current?.focus());
  }

  const toolbar = (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
      aria-describedby={descriptionId}
      aria-busy={busy || isLoading}
    >
      {editing ? (
        <>
          <span role="status" className="mr-auto text-xs text-muted-foreground">
            {t("unsaved")}
          </span>
          <Button
            ref={addButton}
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setAdded(null);
              setLibraryOpen(true);
            }}
          >
            {t("add")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => changeCards(createDefaultOutcomesBoard().cards)}
          >
            {t("reset")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              cancel();
              setLibraryOpen(false);
              setAdded(null);
              restoreEditFocus();
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy || conflicted || !validDraft}
            onClick={() => {
              void save().then(result => {
                if (result) {
                  setLibraryOpen(false);
                  restoreEditFocus();
                }
              });
            }}
          >
            {t(busy ? "saving" : "save")}
          </Button>
        </>
      ) : (
        <Button
          ref={editButton}
          variant="outline"
          size="sm"
          disabled={!data || busy}
          onClick={beginEdit}
        >
          {t("edit")}
        </Button>
      )}
      {!data && !error && (
        <span role="status" className="sr-only">
          {common("loading")}
        </span>
      )}
    </div>
  );

  return (
    <section className="min-w-0 space-y-3" aria-labelledby={titleId}>
      <h2 id={titleId} className="sr-only">
        {t("title")}
      </h2>
      <p id={descriptionId} className="sr-only">
        {t("description")}
      </p>
      {!showInlineToolbar && toolbar}
      {editing && (
        <p className="text-xs text-muted-foreground">{t("resetHint")}</p>
      )}
      {!data && error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
        >
          <p className="min-w-0 flex-1">{common("loadFailed")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void mutate().catch(() => {});
            }}
          >
            {common("retry")}
          </Button>
        </div>
      )}
      {data?.unreadable && !editing && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("unreadable")}
        </p>
      )}
      {saveError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p className="min-w-0 flex-1">{common(saveError)}</p>
          {conflicted && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void reloadSaved().then(result => {
                  if (result) {
                    setLibraryOpen(false);
                    restoreEditFocus();
                  }
                });
              }}
            >
              {common("reload")}
            </Button>
          )}
        </div>
      )}
      {cards.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("emptyDescription")}
          </p>
        </div>
      )}
      <fieldset
        disabled={busy}
        className={cn("min-w-0", busy && "pointer-events-none opacity-70")}
      >
        {children({
          cards,
          editing,
          onCardsChange: changeCards,
          toolbar: showInlineToolbar ? toolbar : null,
        })}
      </fieldset>
      <Dialog
        open={libraryOpen}
        onOpenChange={open => {
          if (!busy) setLibraryOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl"
          onCloseAutoFocus={event => {
            event.preventDefault();
            (addButton.current?.isConnected
              ? addButton.current
              : editButton.current
            )?.focus();
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("libraryTitle")}</DialogTitle>
            <DialogDescription>{t("libraryDescription")}</DialogDescription>
          </DialogHeader>
          <div
            ref={libraryOptions}
            className="grid min-h-0 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2"
          >
            {missing.map(id => (
              <Button
                key={id}
                variant="outline"
                disabled={busy}
                className="h-auto min-w-0 justify-start whitespace-normal p-3 text-left"
                onClick={() => addReport(id)}
              >
                {reports(id)}
              </Button>
            ))}
            {missing.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("allAdded")}</p>
            )}
          </div>
          {added && (
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-muted-foreground"
            >
              {t("added", { report: reports(added) })}
            </p>
          )}
          <DialogFooter className="shrink-0">
            <DialogClose asChild>
              <Button ref={libraryClose} variant="outline" disabled={busy}>
                {t("libraryClose")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Remount personal preferences when the workspace or authenticated member changes. */
export function DashboardBoardController(props: ControllerProps) {
  return (
    <WorkspaceDashboardBoardController
      key={`${props.workspaceId}:${props.memberId}`}
      {...props}
    />
  );
}

function WorkspaceDashboardBoardController({
  workspaceId,
  memberId,
  children,
}: ControllerProps) {
  const t = useTranslations("DashboardClientPage.board");
  const {
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
    cancel: cancelPreferences,
    save: savePreferences,
    reloadSaved: reloadPreferences,
  } = useDashboardBoardPreferences(workspaceId, memberId);
  const memory = useDashboardBoardMemory(workspaceId, memberId);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [addedCard, setAddedCard] = useState<DashboardCardId | null>(null);
  // Every dashboard deleted in this edit, in order; all go on save.
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const libraryReturnFocus = useRef<HTMLButtonElement | null>(null);
  const addCardButton = useRef<HTMLButtonElement | null>(null);
  const librarySearch = useRef<HTMLInputElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const saveButton = useRef<HTMLButtonElement | null>(null);
  const menuFocus = useRef<"name" | "save" | "dialog" | null>(null);
  const newReturnFocus = useRef<"menu" | "name" | null>(null);
  const nameId = useId();
  const newNameId = useId();
  const viewId = useId();
  const viewLabelId = useId();
  const viewNameId = useId();
  const listTitleId = useId();
  const librarySearchId = useId();
  const nameErrorId = useId();
  const recommendedId = useId();

  // Remember what the server confirmed so the next visit opens on it at once.
  useEffect(() => {
    if (!data) return;
    writeDashboardBoardMemory(workspaceId, memberId, {
      board: data.state,
      templateId: data.recommendation?.templateId ?? null,
    });
  }, [data, memberId, workspaceId]);

  // Render immediately: until the read succeeds, show this browser's last
  // confirmed layout or the default board read-only, so metrics load in parallel.
  const template = data
    ? startingTemplate(data)
    : (memory.templateId ?? "starter");
  const defaultState = createDefaultDashboardBoard(
    template,
    t(`templates.${template}.title`)
  );
  const saved = data
    ? (data.state ?? defaultState)
    : (memory.board ?? defaultState);
  const board = draft?.state ?? saved;
  const currentViewId =
    draft?.state.activeViewId ??
    selectedViewId ??
    memory.viewId ??
    board.activeViewId;
  const activeView =
    board.views.find(view => view.id === currentViewId) ??
    board.views.find(view => view.id === board.activeViewId)!;
  const editing = draft !== null;
  const validDraft =
    !draft || dashboardBoardStateSchema.safeParse(draft.state).success;
  const recommendation = data?.recommendation ?? null;
  const templates = recommendation
    ? [
        ...DASHBOARD_TEMPLATES.filter(
          item => item.id === recommendation.templateId
        ),
        ...DASHBOARD_TEMPLATES.filter(
          item => item.id !== recommendation.templateId
        ),
      ]
    : DASHBOARD_TEMPLATES;
  const newDisabled =
    !data ||
    busy ||
    conflicted ||
    !validDraft ||
    board.views.length >= DASHBOARD_MAX_VIEWS;
  const missingCards = DASHBOARD_CARD_IDS.filter(
    id => !activeView.cards.some(card => card.id === id)
  );
  const query = libraryQuery.trim().toLowerCase();
  const matchingCards = missingCards.filter(id => {
    const definition = DASHBOARD_CARD_DEFINITIONS[id];
    return [
      t(`cards.${id}`),
      t(`cardDescriptions.${id}`),
      t(`groups.${definition.group}`),
      t(`scopes.${definition.scope}`),
    ].some(text => text.toLowerCase().includes(query));
  });

  /** Editing starts only from a successful read, never from a fallback. */
  function snapshotFor(id = activeView.id): BoardDraft | null {
    if (draft) return draft;
    if (!data) return null;
    return {
      state: { ...saved, activeViewId: id },
      revision: data.revision,
    };
  }

  function beginEdit() {
    const snapshot = snapshotFor();
    if (!snapshot || busy) return;
    setDraft(snapshot);
    setSaveError(null);
  }

  function editActiveView(
    update: (state: DashboardBoardState) => DashboardBoardState
  ) {
    if (busy) return;
    setDraft(current => {
      const snapshot = current ?? snapshotFor();
      return snapshot ? { ...snapshot, state: update(snapshot.state) } : null;
    });
  }

  function changeCards(cards: DashboardBoardCard[]) {
    if (!editing || busy) return;
    editActiveView(state => ({
      ...state,
      views: state.views.map(view =>
        view.id === activeView.id ? { ...view, cards } : view
      ),
    }));
  }

  function openView(id: string) {
    setSelectedViewId(id);
    writeDashboardBoardMemory(workspaceId, memberId, { viewId: id });
    setMenuOpen(false);
  }

  function renameView(id: string) {
    const snapshot = snapshotFor(id);
    if (!snapshot || busy) return;
    openView(id);
    menuFocus.current = "name";
    setDraft({ ...snapshot, state: { ...snapshot.state, activeViewId: id } });
    setSaveError(null);
  }

  function deleteView(id: string, fromMenu = false) {
    const snapshot = snapshotFor();
    const view = snapshot?.state.views.find(item => item.id === id);
    if (!snapshot || !view || busy || snapshot.state.views.length <= 1) return;
    const views = snapshot.state.views.filter(item => item.id !== id);
    const nextActive = id === activeView.id ? views[0].id : activeView.id;
    if (fromMenu) {
      menuFocus.current = "save";
      setMenuOpen(false);
    }
    setDraft({
      ...snapshot,
      state: { ...snapshot.state, views, activeViewId: nextActive },
    });
    setPendingDeletes(current => [...current, view.name]);
    setSaveError(null);
  }

  function openNewFromMenu() {
    menuFocus.current = "dialog";
    newReturnFocus.current = "menu";
    setMenuOpen(false);
    setNewOpen(true);
  }

  function cancel() {
    cancelPreferences();
    setLibraryOpen(false);
    setLibraryQuery("");
    setAddedCard(null);
    setPendingDeletes([]);
  }

  function openLibrary(trigger: HTMLButtonElement) {
    if (!editing) {
      const snapshot = snapshotFor();
      if (!snapshot) return;
      setDraft(snapshot);
    }
    libraryReturnFocus.current = trigger;
    setLibraryQuery("");
    setAddedCard(null);
    setLibraryOpen(true);
  }

  function addCard(id: DashboardCardId) {
    if (busy) return;
    changeCards([...activeView.cards, createDashboardCard(id)]);
    setAddedCard(id);
    requestAnimationFrame(() => librarySearch.current?.focus());
  }

  async function save() {
    const result = await savePreferences();
    if (!result) return;
    const nextViewId = result.state?.activeViewId ?? null;
    setSelectedViewId(nextViewId);
    if (nextViewId)
      writeDashboardBoardMemory(workspaceId, memberId, { viewId: nextViewId });
    setLibraryOpen(false);
    setPendingDeletes([]);
  }

  async function reloadSaved() {
    if (!(await reloadPreferences())) return;
    setSelectedViewId(null);
    cancel();
  }

  function addView(templateId: DashboardTemplateId) {
    const snapshot = snapshotFor();
    if (!snapshot || newDisabled) return;
    const view = createDashboardView(
      templateId,
      newName.trim() || t(`templates.${templateId}.title`),
      crypto.randomUUID()
    );
    setDraft({
      ...snapshot,
      state: {
        ...snapshot.state,
        activeViewId: view.id,
        views: [...snapshot.state.views, view],
      },
    });
    // The new dashboard opens in edit mode; its name is the next thing to set.
    newReturnFocus.current = "name";
    setNewOpen(false);
    setNewName("");
    setSaveError(null);
  }

  return (
    <div className="min-w-0 space-y-4" aria-busy={busy || isLoading}>
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="w-full min-w-0 space-y-1.5 sm:w-auto sm:max-w-sm sm:flex-1">
          <p id={viewLabelId} className="text-xs text-muted-foreground">
            {t("view")}
          </p>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={menuTrigger}
                id={viewId}
                variant="outline"
                disabled={editing || busy}
                aria-labelledby={`${viewLabelId} ${viewNameId}`}
                className="h-9 w-full min-w-0 justify-between gap-3 px-3 text-left"
              >
                <span id={viewNameId} className="min-w-0 truncate">
                  {activeView.name}
                </span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {t("dashboardCount", { count: board.views.length })}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[min(26rem,calc(100vw-2rem))] p-0"
              onCloseAutoFocus={event => {
                const target = menuFocus.current;
                menuFocus.current = null;
                if (!target) return;
                event.preventDefault();
                if (target === "dialog") return;
                requestAnimationFrame(() => {
                  const element =
                    target === "name" ? nameInput.current : saveButton.current;
                  element?.focus();
                  if (target === "name") nameInput.current?.select();
                });
              }}
            >
              <div className="border-b px-4 py-3">
                <p id={listTitleId} className="text-sm font-medium">
                  {t("dashboardsTitle")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("dashboardsDescription")}
                </p>
              </div>
              <ul
                aria-labelledby={listTitleId}
                className="max-h-[min(60dvh,24rem)] space-y-1 overflow-y-auto p-2"
              >
                {board.views.map(view => {
                  const current = view.id === activeView.id;
                  return (
                    <li
                      key={view.id}
                      className={cn(
                        "flex min-w-0 items-center gap-1 rounded-md",
                        current && "bg-muted"
                      )}
                    >
                      <Button
                        variant="ghost"
                        aria-current={current ? "true" : undefined}
                        className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 whitespace-normal px-3 py-2 text-left"
                        onClick={() => openView(view.id)}
                      >
                        <span className="w-full truncate text-sm font-medium">
                          {view.name}
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {t("viewSummary", {
                            count: view.cards.length,
                            template: t(`templates.${view.templateId}.title`),
                          })}
                        </span>
                      </Button>
                      <div className="flex shrink-0 items-center pr-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs"
                          aria-label={`${t("rename")}: ${view.name}`}
                          disabled={!data || busy}
                          onClick={() => renameView(view.id)}
                        >
                          {t("rename")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs text-destructive"
                          aria-label={`${t("delete")}: ${view.name}`}
                          disabled={!data || busy || board.views.length === 1}
                          onClick={() => deleteView(view.id, true)}
                        >
                          {t("deleteShort")}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="border-t p-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={newDisabled}
                  onClick={openNewFromMenu}
                >
                  {t("new")}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!data && !error && (
            <span role="status" className="text-xs text-muted-foreground">
              {t("loading")}
            </span>
          )}
          {editing ? (
            <>
              <span role="status" className="text-xs text-muted-foreground">
                {t("unsavedChanges")}
              </span>
              <Button
                ref={addCardButton}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={event => openLibrary(event.currentTarget)}
              >
                {t("addCard")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={cancel}
              >
                {t("cancel")}
              </Button>
              <Button
                ref={saveButton}
                variant="default"
                size="sm"
                disabled={busy || conflicted || !validDraft}
                onClick={() => {
                  void save();
                }}
              >
                {t(busy ? "saving" : "save")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!data || busy}
              onClick={beginEdit}
            >
              {t("edit")}
            </Button>
          )}
          <Dialog
            open={newOpen}
            onOpenChange={open => {
              if (!busy) setNewOpen(open);
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={newDisabled}>
                {t("new")}
              </Button>
            </DialogTrigger>
            <DialogContent
              showCloseButton={false}
              className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-3xl"
              onCloseAutoFocus={event => {
                const target = newReturnFocus.current;
                newReturnFocus.current = null;
                const element =
                  target === "name"
                    ? nameInput.current
                    : target === "menu"
                      ? menuTrigger.current
                      : null;
                if (element?.isConnected && !element.disabled) {
                  event.preventDefault();
                  element.focus();
                }
              }}
            >
              <DialogHeader className="shrink-0">
                <DialogTitle>{t("newTitle")}</DialogTitle>
                <DialogDescription>{t("newDescription")}</DialogDescription>
              </DialogHeader>
              <div className="shrink-0 space-y-2">
                <Label htmlFor={newNameId}>{t("name")}</Label>
                <Input
                  id={newNameId}
                  value={newName}
                  maxLength={80}
                  disabled={busy}
                  onChange={event => setNewName(event.target.value)}
                  placeholder={t("namePlaceholder")}
                />
              </div>
              <div className="grid min-h-0 min-w-0 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
                {templates.map(item => {
                  const recommended =
                    recommendation?.templateId === item.id
                      ? recommendation
                      : null;
                  return (
                    <Button
                      key={item.id}
                      variant="outline"
                      aria-label={t(`templates.${item.id}.title`)}
                      aria-describedby={
                        recommended
                          ? `${recommendedId}-badge ${recommendedId}`
                          : undefined
                      }
                      className={cn(
                        "h-full min-w-0 flex-col items-start justify-start gap-3 whitespace-normal p-4 text-left",
                        recommended && "border-primary/40 bg-primary/5"
                      )}
                      onClick={() => addView(item.id)}
                    >
                      <span className="flex w-full flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {t(`templates.${item.id}.title`)}
                        </span>
                        {recommended && (
                          <Badge
                            id={`${recommendedId}-badge`}
                            variant="secondary"
                            className="whitespace-normal text-left"
                          >
                            {t("recommended")}
                          </Badge>
                        )}
                      </span>
                      {recommended && (
                        <span
                          id={recommendedId}
                          className="text-xs font-normal leading-relaxed text-foreground"
                        >
                          {t(`recommendationReasons.${recommended.reason}`)}
                        </span>
                      )}
                      <span className="text-sm font-normal leading-relaxed">
                        {t(`templates.${item.id}.question`)}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {t(`templates.${item.id}.description`)}
                      </span>
                      <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
                        {item.cards.map(card => (
                          <span
                            key={card.id}
                            className="rounded-md bg-muted px-2 py-1 text-xs font-normal text-muted-foreground"
                          >
                            {t(`cards.${card.id}`)}
                          </span>
                        ))}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <DialogFooter className="shrink-0">
                <DialogClose asChild>
                  <Button variant="outline" disabled={busy}>
                    {t("close")}
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {!data && error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
        >
          <p className="min-w-0 flex-1">{t("loadFailed")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void mutate().catch(() => {});
            }}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {data?.unreadable && !editing && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("unreadable")}
        </p>
      )}
      {board.views.length >= DASHBOARD_MAX_VIEWS && (
        <p className="text-xs text-muted-foreground">{t("viewLimit")}</p>
      )}
      {editing && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 p-4">
          <div className="min-w-0 flex-1 space-y-2 sm:max-w-sm">
            <Label htmlFor={nameId}>{t("name")}</Label>
            <Input
              ref={nameInput}
              id={nameId}
              maxLength={80}
              value={activeView.name}
              disabled={busy}
              aria-invalid={!activeView.name.trim()}
              aria-describedby={
                !activeView.name.trim() ? nameErrorId : undefined
              }
              onChange={event =>
                editActiveView(state => ({
                  ...state,
                  views: state.views.map(view =>
                    view.id === activeView.id
                      ? { ...view, name: event.target.value }
                      : view
                  ),
                }))
              }
            />
            {!activeView.name.trim() && (
              <p id={nameErrorId} className="text-xs text-destructive">
                {t("nameRequired")}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || board.views.length === 1}
            onClick={() => deleteView(activeView.id)}
          >
            {t("delete")}
          </Button>
          {pendingDeletes.length > 0 && (
            <p role="status" className="w-full text-xs text-muted-foreground">
              {t("deletePending", {
                count: pendingDeletes.length,
                names: pendingDeletes
                  .map(name => t("deletePendingName", { name }))
                  .join(", "),
              })}
            </p>
          )}
          <p className="w-full text-xs text-muted-foreground">
            {t("editHint")}
          </p>
        </div>
      )}

      {saveError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 p-3 text-sm"
        >
          <p className="min-w-0 flex-1">{t(saveError)}</p>
          {conflicted && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void reloadSaved();
              }}
            >
              {t("reload")}
            </Button>
          )}
        </div>
      )}

      {activeView.cards.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="font-medium">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("emptyDescription")}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            disabled={busy || !data}
            onClick={event => openLibrary(event.currentTarget)}
          >
            {t("addCard")}
          </Button>
        </div>
      )}

      <fieldset
        disabled={busy}
        className={cn("min-w-0", busy && "pointer-events-none opacity-70")}
      >
        {children({
          cards: activeView.cards,
          editing,
          onCardsChange: changeCards,
        })}
      </fieldset>

      <Dialog
        open={libraryOpen}
        onOpenChange={open => {
          if (!busy) setLibraryOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"
          onCloseAutoFocus={event => {
            event.preventDefault();
            const target = libraryReturnFocus.current?.isConnected
              ? libraryReturnFocus.current
              : addCardButton.current;
            target?.focus();
          }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("libraryTitle")}</DialogTitle>
            <DialogDescription>{t("libraryDescription")}</DialogDescription>
          </DialogHeader>
          <div className="shrink-0 space-y-2">
            <Label htmlFor={librarySearchId}>{t("librarySearch")}</Label>
            <Input
              ref={librarySearch}
              id={librarySearchId}
              value={libraryQuery}
              disabled={busy}
              onChange={event => setLibraryQuery(event.target.value)}
              placeholder={t("librarySearchPlaceholder")}
            />
            {addedCard && (
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-muted-foreground"
              >
                {t("libraryAdded", { card: t(`cards.${addedCard}`) })}
              </p>
            )}
          </div>
          <div className="min-h-0 space-y-5 overflow-y-auto">
            {DASHBOARD_CARD_GROUPS.map(group => {
              const cards = matchingCards.filter(
                id => DASHBOARD_CARD_DEFINITIONS[id].group === group
              );
              if (!cards.length) return null;
              return (
                <section key={group} className="space-y-2">
                  <h3 className="text-sm font-medium">
                    {t(`groups.${group}`)}
                  </h3>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {cards.map(id => (
                      <Button
                        key={id}
                        variant="outline"
                        disabled={busy}
                        aria-label={t(`cards.${id}`)}
                        className="h-auto min-w-0 flex-col items-start gap-1.5 whitespace-normal p-3 text-left"
                        onClick={() => addCard(id)}
                      >
                        <span className="text-sm font-medium">
                          {t(`cards.${id}`)}
                        </span>
                        <span className="text-xs font-normal leading-relaxed text-muted-foreground">
                          {t(`cardDescriptions.${id}`)}
                        </span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {t(`scopes.${DASHBOARD_CARD_DEFINITIONS[id].scope}`)}
                        </span>
                      </Button>
                    ))}
                  </div>
                </section>
              );
            })}
            {missingCards.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("allCardsAdded")}
              </p>
            )}
            {missingCards.length > 0 && matchingCards.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("libraryNoResults")}
              </p>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                {t("done")}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
