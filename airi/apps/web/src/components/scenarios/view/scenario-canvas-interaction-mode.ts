"use client";

export const SCENARIO_CANVAS_INTERACTION_MODES = ["select", "pan"] as const;

export type ScenarioCanvasInteractionMode =
  (typeof SCENARIO_CANVAS_INTERACTION_MODES)[number];
