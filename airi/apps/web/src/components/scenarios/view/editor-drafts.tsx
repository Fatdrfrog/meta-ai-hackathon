"use client";

import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";

/** Canvas cards unmount when collapsed. Drafts belong to the workspace editor,
 * not to a card or the persisted scenario graph. Keys include scenario/node. */
export function createScenarioEditorDraftStore() {
  const drafts = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const pending = new Set<string>();
  let templateCount = 0;
  const notify = () => listeners.forEach(listener => listener());
  return {
    get: <T,>(key: string) => drafts.get(key) as T | undefined,
    set: (key: string, value: unknown) => {
      if (Object.is(drafts.get(key), value)) return;
      if (
        key.startsWith("template:") &&
        drafts.has(key) !== (value !== undefined)
      ) {
        templateCount += value === undefined ? -1 : 1;
      }
      if (value === undefined) drafts.delete(key);
      else drafts.set(key, value);
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    templateCount: () => templateCount,
    isPending: (key: string) => pending.has(key),
    begin: (key: string) => {
      if (pending.has(key)) return false;
      pending.add(key);
      notify();
      return true;
    },
    finish: (key: string) => {
      pending.delete(key);
      notify();
    },
  };
}

const DraftContext = createContext<ReturnType<
  typeof createScenarioEditorDraftStore
> | null>(null);

export function ScenarioEditorDraftProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState(createScenarioEditorDraftStore);
  return (
    <DraftContext.Provider value={store}>{children}</DraftContext.Provider>
  );
}

export function useScenarioEditorDraftStore() {
  const shared = useContext(DraftContext);
  const [fallback] = useState(createScenarioEditorDraftStore);
  return shared ?? fallback;
}

export function ScenarioTemplateDraftStatus() {
  const store = useScenarioEditorDraftStore();
  const count = useSyncExternalStore(
    store.subscribe,
    store.templateCount,
    () => 0
  );
  const t = useTranslations("Scenarios");
  return count ? (
    <span
      role="status"
      className="max-w-52 text-xs text-amber-700 dark:text-amber-300"
    >
      {t("whatsappTemplateUnpublishedCount", { count })}
    </span>
  ) : null;
}
