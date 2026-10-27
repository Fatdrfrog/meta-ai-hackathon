import {
  readSavedWhatsAppTemplateForm,
  type WhatsAppTemplateFormRemovedAnswer,
} from "@/lib/scenarios/whatsapp-template-form-snapshot";
import type { useTemplateFlowFacts } from "@/hooks/use-template-flow-facts";
import type { TemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-health";
import {
  parseScenarioFormAnswerToken,
  readScenarioStoredFormKey,
  type ScenarioWhatsAppTemplateForm,
} from "@icecore/scenario-contracts";
import { isRecord } from "@icecore/shared/lib/value-utils";
import type { ScenarioActionEditorNodeData } from "../../view/node-enrichment/types";
import type {
  ScenarioTemplateFormLoadReason,
  ScenarioTemplateFormLoadResult,
} from "../../view/use-scenario-template-form-loader";

type TemplateFormFieldsNodeData = Pick<
  ScenarioActionEditorNodeData,
  | "actionWhatsAppTemplateForm"
  | "actionFlowConfig"
  | "uiBulkPrimaryWhatsAppTemplate"
  | "uiScenarioFormKeys"
  | "uiScenarioFormAnswerTokensRead"
>;

type TemplateFormFieldsFacts = Pick<
  ReturnType<typeof useTemplateFlowFacts>,
  "factsByFlowId" | "isRefreshing"
>;

/** A Load, Update or Update anyway the user pressed on the notice. */
export type TemplateFormFieldsRequest = Readonly<{
  reason: Exclude<ScenarioTemplateFormLoadReason, "pick">;
  confirmRemovals?: boolean;
}>;

/** What the notice's button does: read the form again, or save its fields. */
export type TemplateFormFieldsAction = Readonly<
  | { type: "load"; flowId: string; request: TemplateFormFieldsRequest }
  | { type: "refresh"; flowId: string }
>;

/** A press of the notice's button and its answer. */
export type TemplateFormFieldsLoad = Readonly<{
  flowId: string;
  /** The step's form when it was pressed: readTemplateFormFieldsBasis. */
  basis: string;
  /** The facts the notice read then; newer facts count again. */
  facts: TemplateFlowFacts | undefined;
  request: TemplateFormFieldsRequest;
  result: ScenarioTemplateFormLoadResult;
}>;

type ActionNoticeKind =
  | "missing"
  | "duplicate"
  | "changed"
  | "confirm"
  | "unavailable";

export type TemplateFormFieldsNotice = Readonly<
  | { kind: "loading"; live: false }
  | {
      kind: Exclude<ActionNoticeKind, "confirm">;
      action: TemplateFormFieldsAction;
      busy: boolean;
      live: boolean;
    }
  | {
      kind: "confirm";
      /** The answers AI steps read that the update removes. */
      labels: readonly string[];
      action: TemplateFormFieldsAction;
      busy: boolean;
      live: boolean;
    }
  | { kind: "empty" | "partial"; live: boolean }
  | { kind: "loaded"; fieldCount: number; live: true }
>;

/**
 * The step's form and its saved fields, to tell whether a press's answer
 * still describes them.
 */
export function readTemplateFormFieldsBasis(
  nodeData: TemplateFormFieldsNodeData,
  flowId: string | null
): string {
  const saved = flowId ? readSavedWhatsAppTemplateForm(nodeData, flowId) : null;
  return JSON.stringify([
    flowId ?? "",
    saved?.answersKey ?? "",
    saved?.digest ?? "",
    saved?.readAt ?? "",
  ]);
}

/**
 * Whether AI prompts still read an answer an update removes: an AI step
 * edited since the press can stop reading it. The step knows only the
 * tokens of its own form, so an answer of another form's key still counts.
 */
function readsFormAnswer(
  nodeId: string,
  nodeData: TemplateFormFieldsNodeData
): (answer: WhatsAppTemplateFormRemovedAnswer) => boolean {
  const read = nodeData.uiScenarioFormAnswerTokensRead;
  const formKey = nodeData.uiScenarioFormKeys?.get(nodeId);
  return ({ token }) =>
    !read ||
    read.includes(token) ||
    parseScenarioFormAnswerToken(token)?.formKey !== formKey;
}

/**
 * A press's answer while it still describes the step's form: a save while
 * the step's fields differ from those it had at the press, any other answer
 * while they are the same. Undo, or a pick of another form, ends it. A
 * confirmation names only the answers AI prompts still read, and ends once
 * they read none, as the update then removes nothing they read.
 */
function readRecentLoad(
  lastLoad: TemplateFormFieldsLoad | null | undefined,
  flowId: string,
  basis: string,
  saved: ScenarioWhatsAppTemplateForm | null,
  isRead: (answer: WhatsAppTemplateFormRemovedAnswer) => boolean
): TemplateFormFieldsLoad | null {
  if (
    !lastLoad ||
    lastLoad.flowId !== flowId ||
    lastLoad.result.status === "skipped"
  ) {
    return null;
  }
  if (lastLoad.result.status === "saved") {
    return saved && lastLoad.basis !== basis ? lastLoad : null;
  }
  if (lastLoad.basis !== basis) return null;
  if (lastLoad.result.status !== "needs_confirmation") return lastLoad;
  const newlyUnavailable = lastLoad.result.newlyUnavailable.filter(isRead);
  return newlyUnavailable.length > 0
    ? { ...lastLoad, result: { ...lastLoad.result, newlyUnavailable } }
    : null;
}

function isLater(time: string, than: string): boolean {
  return Date.parse(time) > (Date.parse(than) || 0);
}

/** WhatsApp's form sends other answers than the saved fields list. */
function hasNewerFields(
  facts: TemplateFlowFacts | undefined,
  saved: ScenarioWhatsAppTemplateForm
): boolean {
  return (
    facts?.state === "found" &&
    isRecord(facts.answerSchema) &&
    facts.answerSchema.digest !== saved.digest &&
    // A Load reads WhatsApp after these facts; its fields are not older.
    isLater(facts.checkedAt, saved.readAt)
  );
}

function isUnreadable(facts: TemplateFlowFacts | undefined): boolean {
  return (
    facts?.state === "unavailable" ||
    (facts?.state === "found" && !isRecord(facts.answerSchema))
  );
}

/**
 * The saved fields' key is an earlier form's, so AI steps read that form's
 * answers. A Load gives the form its own. A key its Flow config stores wins
 * at read time, so a Load can't move it; validation names that one.
 */
function hasTakenKey(
  nodeId: string,
  nodeData: TemplateFormFieldsNodeData,
  saved: ScenarioWhatsAppTemplateForm
): boolean {
  const key = nodeData.uiScenarioFormKeys?.get(nodeId);
  return (
    Boolean(key) &&
    !readScenarioStoredFormKey(nodeData.actionFlowConfig) &&
    saved.answersKey !== key
  );
}

function resolveSettledNotice({
  nodeId,
  nodeData,
  flowId,
  facts,
  saved,
  recent,
}: {
  nodeId: string;
  nodeData: TemplateFormFieldsNodeData;
  flowId: string;
  facts: TemplateFlowFacts | undefined;
  saved: ScenarioWhatsAppTemplateForm | null;
  recent: TemplateFormFieldsLoad | null;
}): TemplateFormFieldsNotice | null {
  const live = recent !== null;
  const load = (request: TemplateFormFieldsRequest) => ({
    type: "load" as const,
    flowId,
    request,
  });
  if (recent?.result.status === "needs_confirmation") {
    return {
      kind: "confirm",
      labels: recent.result.newlyUnavailable.map(answer => answer.label),
      action: load({ reason: "update", confirmRemovals: true }),
      busy: false,
      live,
    };
  }
  if (
    recent?.result.status === "unavailable" ||
    recent?.result.status === "missing"
  ) {
    return {
      kind: "unavailable",
      action: load(recent.request),
      busy: false,
      live,
    };
  }
  if (!saved) {
    return {
      kind: "missing",
      action: load({ reason: "load" }),
      busy: false,
      live,
    };
  }
  // Saved fields exist from here on, so a press asks before it removes
  // answers AI steps read.
  if (hasTakenKey(nodeId, nodeData, saved)) {
    return {
      kind: "duplicate",
      action: load({ reason: "update" }),
      busy: false,
      live,
    };
  }
  // A press read WhatsApp after the facts the notice has.
  const readSinceFacts =
    (recent?.result.status === "saved" ||
      recent?.result.status === "unchanged") &&
    recent.facts === facts;
  if (!readSinceFacts && hasNewerFields(facts, saved)) {
    return {
      kind: "changed",
      action: load({ reason: "update" }),
      busy: false,
      live,
    };
  }
  if (!readSinceFacts && isUnreadable(facts)) {
    return {
      kind: "unavailable",
      action: { type: "refresh", flowId },
      busy: false,
      live,
    };
  }
  if (saved.coverage === "partial") return { kind: "partial", live };
  if (saved.fields.length === 0) return { kind: "empty", live };
  return recent
    ? { kind: "loaded", fieldCount: saved.fields.length, live: true }
    : null;
}

/**
 * The notice a template step shows about the fields of the form its one
 * FLOW button opens, which AI steps read: load them, update them after the
 * form changed in WhatsApp, or confirm an update that removes answers AI
 * steps read. It shows nothing for a form built here, which lists its own
 * fields, on a bulk send, which has no Form submitted route, or when
 * WhatsApp has no such form, which the form health notice warns about.
 */
export function resolveTemplateFormFieldsNotice({
  nodeId,
  nodeData,
  flowId,
  flowFacts,
  formLoading,
  lastLoad,
}: {
  nodeId: string;
  nodeData: TemplateFormFieldsNodeData;
  /**
   * The Flow a press loads: the one the step's saved FLOW button opens, as
   * the loader reads it. The template the step shows can be the approved
   * one, whose form a press can't load.
   */
  flowId: string | null;
  /** The step's facts about its forms, shared with the form health notice. */
  flowFacts: TemplateFormFieldsFacts;
  /** A pick or a press is reading the form. */
  formLoading: boolean;
  lastLoad?: TemplateFormFieldsLoad | null;
}): TemplateFormFieldsNotice | null {
  if (!flowId || nodeData.uiBulkPrimaryWhatsAppTemplate) return null;
  const facts = flowFacts.factsByFlowId[flowId];
  if (facts?.state === "missing") return null;
  const saved = readSavedWhatsAppTemplateForm(nodeData, flowId);
  const notice = resolveSettledNotice({
    nodeId,
    nodeData,
    flowId,
    facts,
    saved,
    recent: readRecentLoad(
      lastLoad,
      flowId,
      readTemplateFormFieldsBasis(nodeData, flowId),
      saved,
      readsFormAnswer(nodeId, nodeData)
    ),
  });
  if (notice && "action" in notice) {
    return {
      ...notice,
      busy:
        formLoading ||
        (notice.action.type === "refresh" && flowFacts.isRefreshing([flowId])),
    };
  }
  return formLoading ? { kind: "loading", live: false } : notice;
}
