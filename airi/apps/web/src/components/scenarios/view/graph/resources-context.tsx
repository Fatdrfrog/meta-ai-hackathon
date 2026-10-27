"use client";

import { createContext, useContext, type ReactNode } from "react";

export type ScenarioGraphResourcesState = {
  whatsAppTemplatesLoading: boolean;
  whatsAppTemplatesRefreshing: boolean;
  /** False until the catalog first loads, so a missing template isn't final. */
  hasLoadedWhatsAppTemplates: boolean;
  /**
   * The last catalog read failed, or the catalog is a saved copy Meta
   * couldn't refresh. `code` is the catalog error code, such as
   * WHATSAPP_TEMPLATES_RATE_LIMITED for Meta's limit.
   */
  whatsAppTemplatesError?: {
    retryAt: string | null;
    code?: string | null;
  } | null;
  whatsAppFlowsLoading: boolean;
  whatsAppFlowsRefreshing: boolean;
  contextItemsLoading: boolean;
};

const defaultState: ScenarioGraphResourcesState = {
  whatsAppTemplatesLoading: false,
  whatsAppTemplatesRefreshing: false,
  // Without a provider nothing loads the catalog, so there is nothing to wait for.
  hasLoadedWhatsAppTemplates: true,
  whatsAppFlowsLoading: false,
  whatsAppFlowsRefreshing: false,
  contextItemsLoading: false,
};

const ScenarioGraphResourcesContext =
  createContext<ScenarioGraphResourcesState>(defaultState);

export function ScenarioGraphResourcesProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ScenarioGraphResourcesState;
}) {
  return (
    <ScenarioGraphResourcesContext.Provider value={value}>
      {children}
    </ScenarioGraphResourcesContext.Provider>
  );
}

export function useScenarioGraphResources(): ScenarioGraphResourcesState {
  return useContext(ScenarioGraphResourcesContext);
}
