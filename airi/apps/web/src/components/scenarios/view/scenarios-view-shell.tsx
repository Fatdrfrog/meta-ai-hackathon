"use client";

import { ScenariosWorkspaceSkeleton } from "@/components/scenarios/scenarios-workspace-skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { GitBranch, Loader2, PlugZap, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { type ReactNode } from "react";
import type { ScenarioWorkspacePendingConfirmation } from "../workspace/use-scenario-workspace-entity";

type ScenariosViewLoadingStateProps = {
  label: string;
};

export function ScenariosViewLoadingState({
  label,
}: ScenariosViewLoadingStateProps) {
  return (
    <div className="h-full min-h-0" role="status" aria-label={label}>
      <ScenariosWorkspaceSkeleton />
    </div>
  );
}

type ScenariosViewEmptyStateProps = {
  title: string;
  description: string;
  createLabel: string;
  demoCreateLabel: string;
  connectSourceLabel: string;
  connectSourceHref: string;
  isCreating: boolean;
  isAutoCreatingDemo: boolean;
  showDemoRetry: boolean;
  showConnectSource: boolean;
  createDisabled?: boolean;
  limitNotice?: ReactNode;
  onCreateScenario: () => void;
  onCreateDemoScenario: () => void;
};

export function ScenariosViewEmptyState({
  title,
  description,
  createLabel,
  demoCreateLabel,
  connectSourceLabel,
  connectSourceHref,
  isCreating,
  isAutoCreatingDemo,
  showDemoRetry,
  showConnectSource,
  createDisabled = false,
  limitNotice,
  onCreateScenario,
  onCreateDemoScenario,
}: ScenariosViewEmptyStateProps) {
  return (
    <div className="flex h-full min-h-0 overflow-y-auto bg-muted/20 p-4 sm:p-6">
      <div className="m-auto grid w-full max-w-5xl items-center gap-8 md:grid-cols-[1fr_1fr] lg:gap-12">
        <div className="min-w-0 space-y-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border bg-background shadow-sm">
            {isAutoCreatingDemo ? (
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            ) : (
              <GitBranch className="h-5 w-5 text-primary" />
            )}
          </div>
          <div className="max-w-xl space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 [&_button]:max-w-full [&_a]:max-w-full [&_.btn-push-front]:whitespace-normal [&_.btn-push-front]:text-center">
            {showDemoRetry ? (
              <Button
                type="button"
                onClick={onCreateDemoScenario}
                disabled={isCreating || createDisabled}
                className="h-auto min-h-10 whitespace-normal rounded-md text-center"
              >
                {isCreating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {demoCreateLabel}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={onCreateScenario}
                disabled={isCreating || isAutoCreatingDemo || createDisabled}
                className="h-auto min-h-10 whitespace-normal rounded-md text-center"
              >
                {isCreating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {createLabel}
              </Button>
            )}
            {showConnectSource ? (
              <Button
                asChild
                type="button"
                variant="outline"
                className="h-auto min-h-10 whitespace-normal rounded-md text-center"
              >
                <Link href={connectSourceHref}>
                  <PlugZap className="h-4 w-4" />
                  {connectSourceLabel}
                </Link>
              </Button>
            ) : null}
          </div>
          {limitNotice ? <div>{limitNotice}</div> : null}
        </div>

        <div
          aria-hidden
          className="relative hidden min-w-0 flex-col rounded-xl border bg-background p-6 md:flex"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,hsl(var(--primary)/0.12),transparent_26%),linear-gradient(to_right,hsl(var(--border)/0.45)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.45)_1px,transparent_1px)] bg-[length:100%_100%,28px_28px,28px_28px]" />
          <div className="relative w-4/5 max-w-56 self-start rounded-lg border border-amber-300/70 bg-background/95 p-3 shadow-sm">
            <div className="mb-2 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="h-2 w-16 rounded-full bg-amber-400/40" />
            </div>
            <div className="h-2 w-3/5 rounded-full bg-muted" />
            <div className="mt-2 h-2 w-4/5 rounded-full bg-muted" />
          </div>
          <div className="relative mr-[40%] h-6 w-px self-end bg-border" />
          <div className="relative w-4/5 max-w-56 self-end rounded-lg border border-blue-300/70 bg-background/95 p-3 shadow-sm">
            <div className="mb-2 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-400" />
              <span className="h-2 w-20 rounded-full bg-blue-400/40" />
            </div>
            <div className="h-2 w-4/5 rounded-full bg-muted" />
            <div className="mt-2 h-2 w-3/5 rounded-full bg-muted" />
          </div>
          <div className="relative ml-[40%] h-6 w-px bg-border" />
          <div className="relative w-4/5 max-w-56 self-start rounded-lg border border-emerald-300/70 bg-background/95 p-3 shadow-sm">
            <div className="mb-2 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="h-2 w-14 rounded-full bg-emerald-400/40" />
            </div>
            <div className="h-2 w-3/4 rounded-full bg-muted" />
            <div className="mt-2 h-2 w-1/2 rounded-full bg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}

type ScenarioFlowLoadingStateProps = {
  label: string;
};

export function ScenarioFlowLoadingState({
  label,
}: ScenarioFlowLoadingStateProps) {
  return (
    <div
      className="relative h-full min-h-0 overflow-hidden bg-muted/20"
      role="status"
      aria-label={label}
    >
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.45)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.45)_1px,transparent_1px)] bg-[size:28px_28px]" />
      <div className="absolute left-10 top-16 w-48 rounded-lg border bg-background/95 p-3 shadow-sm">
        <div className="h-3 w-20 animate-pulse rounded-md bg-muted" />
        <div className="mt-2 h-3 w-32 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="absolute left-[19rem] top-28 w-52 rounded-lg border bg-background/95 p-3 shadow-sm">
        <div className="h-3 w-24 animate-pulse rounded-md bg-muted" />
        <div className="mt-2 h-3 w-36 animate-pulse rounded-md bg-muted" />
      </div>
    </div>
  );
}

type ScenarioPendingConfirmationDialogProps = {
  pendingConfirmation: ScenarioWorkspacePendingConfirmation | null;
  cancelLabel: string;
  createLabel: string;
  deleteLabel: string;
  deleteDescription: string;
  secondTriggerDescription: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};

export function ScenarioPendingConfirmationDialog({
  pendingConfirmation,
  cancelLabel,
  createLabel,
  deleteLabel,
  deleteDescription,
  secondTriggerDescription,
  onConfirm,
  onOpenChange,
}: ScenarioPendingConfirmationDialogProps) {
  return (
    <AlertDialog
      open={Boolean(pendingConfirmation)}
      onOpenChange={onOpenChange}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pendingConfirmation?.kind === "delete_scenario"
              ? deleteLabel
              : createLabel}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pendingConfirmation?.kind === "delete_scenario"
              ? deleteDescription
              : secondTriggerDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {pendingConfirmation?.kind === "delete_scenario"
              ? deleteLabel
              : createLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
