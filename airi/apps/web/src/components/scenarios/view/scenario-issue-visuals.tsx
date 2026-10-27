"use client";

import { AlertCircle, Info, TriangleAlert } from "lucide-react";

export type ScenarioIssueVisualSeverity = "error" | "warning" | "info";

export function getScenarioIssueSoftTone(
  severity: ScenarioIssueVisualSeverity
) {
  switch (severity) {
    case "error":
      return "border-rose-200 bg-rose-50/70";
    case "warning":
      return "border-amber-200 bg-amber-50/70";
    default:
      return "border-sky-200 bg-sky-50/70";
  }
}

export function ScenarioIssueIcon({
  severity,
  className,
}: {
  severity: ScenarioIssueVisualSeverity;
  className?: string;
}) {
  if (severity === "error") {
    return <AlertCircle className={className} />;
  }
  if (severity === "warning") {
    return <TriangleAlert className={className} />;
  }
  return <Info className={className} />;
}
