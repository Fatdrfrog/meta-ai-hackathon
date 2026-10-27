"use client";

import type { WhatsAppFlowFieldType } from "@icecore/scenario-contracts";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

const INPUT_SAMPLE_CLASS =
  "mt-1.5 flex h-8 items-center rounded-md border border-gray-200 bg-gray-50/60 px-2 text-[11px] text-gray-400 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-500";

/** A static sample of the input the customer fills. */
export function FlowFieldInputSample({
  fieldType,
  className,
}: {
  fieldType: WhatsAppFlowFieldType;
  className?: string;
}) {
  const t = useTranslations("Scenarios");
  if (fieldType === "TextArea") {
    return (
      <div
        className={cn(
          "mt-1.5 rounded-md border border-gray-200 bg-gray-50/60 px-2 py-1.5 text-[11px] text-gray-400 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-500",
          className
        )}
      >
        {t("flowFieldSampleAnswer")}
      </div>
    );
  }
  if (fieldType === "Dropdown") {
    return (
      <div className={cn(INPUT_SAMPLE_CLASS, "justify-between", className)}>
        <span>{t("flowFieldSampleOption")}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className={cn(INPUT_SAMPLE_CLASS, className)}>
      {t(
        fieldType === "DatePicker"
          ? "flowFieldSampleDate"
          : "flowFieldSampleAnswer"
      )}
    </div>
  );
}

export function FlowFieldChoiceMarker({ radio }: { radio: boolean }) {
  return (
    <div
      className={cn(
        "h-3 w-3 shrink-0 border border-gray-300 dark:border-gray-600",
        radio ? "rounded-full" : "rounded-[2px]"
      )}
    />
  );
}
