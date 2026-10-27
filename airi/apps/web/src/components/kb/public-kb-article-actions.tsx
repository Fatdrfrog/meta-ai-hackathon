"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, FileText } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  buildPublicKBLLMText,
  buildPublicKBMarkdown,
} from "./public-kb-copy-format";

type PublicKBArticleAction = "markdown" | "llm";

export type PublicKBArticleActionsLabels = {
  copyMarkdown: string;
  copyForLLM: string;
  copiedMarkdown: string;
  copiedForLLM: string;
  copyFailed: string;
};

type PublicKBArticleActionsProps = {
  title: string;
  content: string;
  articleUrl: string;
  companyName: string;
  locale: string;
  publishedAt?: string | null;
  updatedAt?: string | null;
  labels: PublicKBArticleActionsLabels;
  className?: string;
};

function getClipboard() {
  return typeof navigator !== "undefined" ? navigator.clipboard : undefined;
}

async function writeClipboardText(value: string) {
  const clipboard = getClipboard();
  if (clipboard?.writeText) {
    await clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard API is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }

  if (!copied) {
    throw new Error("Clipboard fallback failed");
  }
}

export function PublicKBArticleActions({
  title,
  content,
  articleUrl,
  companyName,
  locale,
  publishedAt,
  updatedAt,
  labels,
  className,
}: PublicKBArticleActionsProps) {
  const [copiedAction, setCopiedAction] =
    useState<PublicKBArticleAction | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  const markdown = useMemo(
    () => buildPublicKBMarkdown({ title, content }),
    [content, title]
  );
  const llmText = useMemo(
    () =>
      buildPublicKBLLMText({
        title,
        content,
        articleUrl,
        companyName,
        locale,
        publishedAt,
        updatedAt,
      }),
    [articleUrl, companyName, content, locale, publishedAt, title, updatedAt]
  );

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const copyText = useCallback(
    async (
      action: PublicKBArticleAction,
      value: string,
      successMessage: string
    ) => {
      try {
        await writeClipboardText(value);
        setCopiedAction(action);
        toast.success(successMessage);

        if (resetTimerRef.current) {
          window.clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = window.setTimeout(() => {
          setCopiedAction(null);
        }, 1200);
      } catch {
        toast.error(labels.copyFailed);
      }
    },
    [labels.copyFailed]
  );

  const actions = [
    {
      id: "markdown" as const,
      label: labels.copyMarkdown,
      copiedLabel: labels.copiedMarkdown,
      value: markdown,
      icon: FileText,
    },
    {
      id: "llm" as const,
      label: labels.copyForLLM,
      copiedLabel: labels.copiedForLLM,
      value: llmText,
      icon: Bot,
    },
  ];

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto",
          className
        )}
      >
        {actions.map(action => {
          const Icon = copiedAction === action.id ? Check : action.icon;
          const ariaLabel =
            copiedAction === action.id ? action.copiedLabel : action.label;

          return (
            <Tooltip key={action.id}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-md px-2 text-xs text-foreground shadow-none"
                  aria-label={ariaLabel}
                  onClick={() =>
                    copyText(action.id, action.value, action.copiedLabel)
                  }
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{action.label}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{ariaLabel}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
