"use client";

import { Button } from "@/components/ui/button";
import type { useTemplateFlowFacts } from "@/hooks/use-template-flow-facts";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import { ScenarioInlineNotice } from "../../scenario-inline-notice";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import type { ScenarioIssueVisualSeverity } from "../../view/scenario-issue-visuals";
import { formatQuotedLabelList } from "../../view/scenario-template-utils";
import {
  readTemplateFormFieldsBasis,
  resolveTemplateFormFieldsNotice,
  type TemplateFormFieldsAction,
  type TemplateFormFieldsLoad,
  type TemplateFormFieldsNotice,
} from "./action-node-whatsapp-template-form-fields-state";

const CARD_CONTROL_CLASS = "nodrag nopan nokey";

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

type TemplateFlowFactsReader = Pick<
  ReturnType<typeof useTemplateFlowFacts>,
  "factsByFlowId" | "refresh" | "isRefreshing"
>;

/**
 * A press of the notice's button, made while it had focus. A Load or Update
 * saves its answer on the step, which can hide the notice until the answer
 * comes: `saving` until then.
 */
type FocusedPress = { button: HTMLButtonElement; saving: boolean };

const NOTICE_COPY: Record<
  TemplateFormFieldsNotice["kind"],
  { message: string; tone: ScenarioIssueVisualSeverity }
> = {
  loading: { message: "whatsappTemplateFormFieldsLoading", tone: "info" },
  missing: { message: "whatsappTemplateFormFieldsMissing", tone: "info" },
  duplicate: {
    message: "whatsappTemplateFormFieldsDuplicateKey",
    tone: "warning",
  },
  changed: { message: "whatsappTemplateFormFieldsChanged", tone: "warning" },
  confirm: {
    message: "whatsappTemplateFormFieldsRemovesUsed",
    tone: "warning",
  },
  unavailable: {
    message: "whatsappTemplateFormFieldsUnavailable",
    tone: "warning",
  },
  empty: { message: "whatsappTemplateFormFieldsEmpty", tone: "info" },
  partial: { message: "whatsappTemplateFormFieldsPartial", tone: "info" },
  loaded: { message: "whatsappTemplateFormFieldsLoaded", tone: "info" },
};

const ACTION_LABELS: Record<
  Extract<TemplateFormFieldsNotice, { action: unknown }>["kind"],
  string
> = {
  missing: "whatsappTemplateFormFieldsLoad",
  duplicate: "whatsappTemplateFormFieldsLoad",
  changed: "whatsappTemplateFormFieldsUpdate",
  confirm: "whatsappTemplateFormFieldsUpdateAnyway",
  unavailable: "retry",
};

/**
 * Tells a template step whether AI steps can read the answers of the form
 * its FLOW button opens, and loads or updates the form's fields from
 * WhatsApp on a press. It reads the facts the form health notice shows, and
 * opening the step never saves anything.
 */
export function ActionNodeWhatsAppTemplateFormFields({
  id,
  nodeData,
  flowFacts,
}: {
  id: string;
  nodeData: ScenarioActionEditorNodeData;
  /** The step's facts about its forms, shared with the form health notice. */
  flowFacts: TemplateFlowFactsReader;
}) {
  const t = useTranslations("Scenarios");
  const formFields = nodeData.uiWhatsAppTemplates.formFields;
  const { factsByFlowId, isRefreshing } = flowFacts;
  const [lastLoad, setLastLoad] = useState<TemplateFormFieldsLoad | null>(null);
  const textId = useId();
  const noticeRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  // The press of the focused button: kept while focus stays on the button,
  // and while its answer is saved with the notice hidden.
  const pressRef = useRef<FocusedPress | null>(null);
  const notice = useMemo(
    () =>
      resolveTemplateFormFieldsNotice({
        nodeId: id,
        nodeData,
        flowId: formFields.flowId,
        flowFacts: { factsByFlowId, isRefreshing },
        formLoading: formFields.loading,
        lastLoad,
      }),
    [
      factsByFlowId,
      formFields.flowId,
      formFields.loading,
      id,
      isRefreshing,
      lastLoad,
      nodeData,
    ]
  );

  // A press's answer can take the focused button away, and focus would then
  // fall to the page, or to the drawer around the step. It stays on the
  // notice instead: on its new button, or on the notice itself. Only the
  // press moves focus, and only while focus is still where it fell.
  useLayoutEffect(() => {
    const press = pressRef.current;
    if (!press) return;
    const active = document.activeElement;
    if (press.button.isConnected) {
      // The user moved focus away: the answer leaves it there.
      if (active !== press.button) pressRef.current = null;
      return;
    }
    const target = actionRef.current ?? noticeRef.current;
    const fallen = !active || active === document.body;
    // Hidden while the answer is saved on the step: wait for the answer.
    if (!target && fallen && press.saving) return;
    if (target && (fallen || active?.contains(target))) {
      target.focus({ preventScroll: true });
    }
    pressRef.current = null;
  });

  const run = async (
    action: TemplateFormFieldsAction,
    button: HTMLButtonElement
  ) => {
    const press: FocusedPress | null =
      document.activeElement === button
        ? { button, saving: action.type === "load" }
        : null;
    pressRef.current = press;
    if (action.type === "refresh") {
      setLastLoad(null);
      await flowFacts.refresh([action.flowId]);
      return;
    }
    const pressed = {
      flowId: action.flowId,
      basis: readTemplateFormFieldsBasis(nodeData, formFields.flowId),
      facts: flowFacts.factsByFlowId[action.flowId],
      request: action.request,
    };
    const { reason, ...options } = action.request;
    const result = await formFields
      .load(reason, options)
      .catch(() => ({ status: "unavailable" as const }));
    // The answer is in: a notice hidden from now on stays hidden.
    if (press) press.saving = false;
    setLastLoad({ ...pressed, result });
  };

  const copy = notice ? NOTICE_COPY[notice.kind] : null;
  const removed =
    notice?.kind === "confirm" ? formatQuotedLabelList(notice.labels, t) : null;
  const message =
    !notice || !copy
      ? null
      : notice.kind === "loaded"
        ? t(copy.message, { count: notice.fieldCount })
        : removed
          ? t(copy.message, { labels: removed.labels })
          : t(copy.message);
  const busy = notice !== null && "action" in notice && notice.busy;
  return (
    <>
      {/* Mounted before any press, so screen readers read out each press's
          answer. The notice shows on open, which nothing reads out. */}
      <span
        role="status"
        className="sr-only"
        data-testid="whatsapp-template-form-fields-status"
      >
        {notice?.live && !busy ? message : null}
      </span>
      {notice && copy ? (
        <ScenarioInlineNotice
          focusRef={noticeRef}
          tone={copy.tone}
          // Keys on the focused notice never move or select the step.
          className="nokey w-full"
          data-testid="whatsapp-template-form-fields-notice"
          details={
            removed
              ? t("whatsappTemplateFormFieldsRemovesUsedDetails")
              : undefined
          }
          detailsLabel={
            removed
              ? t("infoHintLabel", {
                  topic: t("whatsappTemplateFormFieldsUpdateAnyway"),
                })
              : undefined
          }
        >
          <span
            id={textId}
            className="block"
            data-testid="whatsapp-template-form-fields-text"
          >
            {message}
          </span>
          {"action" in notice ? (
            // The labels are long in Kazakh, so the button goes under the text.
            <Button
              ref={actionRef}
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                CARD_CONTROL_CLASS,
                "mt-1.5 h-auto min-h-7 max-w-full gap-1 whitespace-normal break-words bg-background px-2 py-1 text-left text-[11px] text-foreground",
                notice.busy && "cursor-wait opacity-70"
              )}
              // aria-disabled instead of disabled keeps keyboard focus on the button.
              aria-disabled={notice.busy}
              aria-busy={notice.busy}
              aria-describedby={textId}
              data-testid="whatsapp-template-form-fields-action"
              onPointerDown={stopPropagation}
              onClick={event => {
                event.stopPropagation();
                if (!notice.busy) void run(notice.action, event.currentTarget);
              }}
              // Enter and Space press this button, never the step around it.
              onKeyDown={stopPropagation}
            >
              {notice.busy ? (
                <Loader2
                  aria-hidden
                  className="size-3.5 shrink-0 animate-spin"
                />
              ) : null}
              {notice.busy
                ? t("whatsappTemplateFormFieldsLoading")
                : t(ACTION_LABELS[notice.kind])}
            </Button>
          ) : null}
        </ScenarioInlineNotice>
      ) : null}
    </>
  );
}
