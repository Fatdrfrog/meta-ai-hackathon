"use client";

import { createContext, type ReactNode } from "react";
import type { ScenarioSourceHandlePresentation } from "./source-handle-types";

export const ScenarioSourceHandlePresentationContext =
  createContext<ScenarioSourceHandlePresentation | null>(null);

export function ScenarioSourceHandlePresentationProvider({
  value,
  children,
}: {
  value: ScenarioSourceHandlePresentation | null;
  children: ReactNode;
}) {
  return (
    <ScenarioSourceHandlePresentationContext.Provider value={value}>
      {children}
    </ScenarioSourceHandlePresentationContext.Provider>
  );
}
