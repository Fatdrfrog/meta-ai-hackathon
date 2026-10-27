"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CheckCircle2, CircleDot } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode, RefObject } from "react";
import type { SetupStep } from "./setup-wizard-state";

export function SetupStepRail({
  activeStep,
  canReturnToRequired,
  navigationDisabled,
  requiredStepComplete,
  workspaceId,
  onStepChange,
}: {
  activeStep: SetupStep;
  canReturnToRequired: boolean;
  navigationDisabled: boolean;
  requiredStepComplete: boolean;
  workspaceId: string;
  onStepChange: (step: SetupStep) => void;
}) {
  const t = useTranslations("AddCompanyForm");

  return (
    <div className="grid h-auto w-full grid-cols-2 items-stretch gap-1.5 rounded-[1.5rem] border-[3px] border-foreground bg-muted/40 p-1.5 sm:gap-2">
      <StepRailItem
        active={activeStep === "required"}
        complete={requiredStepComplete}
        step={t("stepLabel", { number: "1" })}
        title={t("requiredStepTab")}
        variant="required"
        disabled={navigationDisabled}
        onClick={
          canReturnToRequired ? () => onStepChange("required") : undefined
        }
      />
      <StepRailItem
        active={activeStep === "product"}
        complete={false}
        disabled={navigationDisabled || !requiredStepComplete}
        step={t("stepLabel", { number: "2" })}
        title={t("productStepTab")}
        variant="product"
        onClick={workspaceId ? () => onStepChange("product") : undefined}
      />
    </div>
  );
}

function StepRailItem({
  active,
  complete,
  disabled = false,
  onClick,
  step,
  title,
  variant,
}: {
  active: boolean;
  complete: boolean;
  disabled?: boolean;
  onClick?: () => void;
  step: string;
  title: string;
  variant: SetupStep;
}) {
  const activeClass =
    variant === "required"
      ? "bg-[#cfffe1] text-black dark:bg-emerald-950/50 dark:text-white"
      : "bg-[#fec8e7] text-black dark:bg-rose-950/50 dark:text-white";
  const content = (
    <span className="flex min-w-0 items-center gap-2">
      {complete ? (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-[#cfffe1] text-emerald-800 shadow-[1px_1px_0px_#000000]">
          <CheckCircle2
            className="h-3.5 w-3.5 stroke-[3px]"
            aria-hidden="true"
          />
        </span>
      ) : (
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-muted-foreground/20 text-muted-foreground shadow-[1px_1px_0px_#000000]">
          <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
      <span className="min-w-0">
        <span
          aria-hidden="true"
          className="block text-[9px] font-bold uppercase leading-none text-muted-foreground"
        >
          {step}
        </span>
        <span className="block break-words text-xs font-bold leading-4">
          {title}
        </span>
      </span>
    </span>
  );

  const className = cn(
    "h-auto min-h-12 min-w-0 justify-start whitespace-normal rounded-xl border-2 px-3 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary focus-visible:ring-offset-2",
    active
      ? cn("border-foreground shadow-[2px_2px_0px_#000000]", activeClass)
      : "border-transparent bg-transparent",
    disabled && "opacity-50"
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "step" : undefined}
        data-complete={complete}
        className={className}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      aria-current={active ? "step" : undefined}
      aria-disabled={disabled || undefined}
      data-complete={complete}
      className={className}
    >
      {content}
    </div>
  );
}

export function StepSectionHeader({
  badge,
  description,
  headingRef,
  icon,
  step,
  title,
  variant = "required",
}: {
  badge: string;
  description: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  icon: ReactNode;
  step: string;
  title: string;
  variant?: SetupStep;
}) {
  const bgClass =
    variant === "required"
      ? "bg-[#cfffe1] dark:bg-emerald-950/40 text-black dark:text-foreground"
      : "bg-[#fec8e7] dark:bg-rose-950/40 text-black dark:text-foreground";

  return (
    <div
      className={cn(
        "rounded-2xl border-[3px] border-foreground p-4 shadow-[4px_4px_0px_#000000] dark:shadow-[4px_4px_0px_rgba(255,255,255,0.15)]",
        bgClass
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-background border-2 border-foreground text-primary shadow-[2px_2px_0px_#000000] dark:shadow-[2px_2px_0px_rgba(255,255,255,0.15)]">
            {icon}
          </div>
          <div className="min-w-0 space-y-1 break-words">
            <p className="text-[10px] font-bold uppercase tracking-wider opacity-60">
              {step}
            </p>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-base font-bold leading-snug focus:outline-none"
            >
              {title}
            </h2>
            <p className="text-xs leading-relaxed opacity-85">{description}</p>
          </div>
        </div>
        <Badge className="max-w-full self-start whitespace-normal border-2 border-foreground bg-background text-foreground hover:bg-background shadow-[2px_2px_0px_#000000] dark:shadow-[2px_2px_0px_rgba(255,255,255,0.15)] px-3 py-1 text-xs font-bold">
          {badge}
        </Badge>
      </div>
    </div>
  );
}
