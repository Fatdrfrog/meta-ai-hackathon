import { listWhatsAppTemplateButtonDrift } from "@/lib/scenarios/whatsapp-template-button-branches";
import { normalizeEditableTemplateFlowId } from "@/lib/scenarios/whatsapp-template-flow";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonSourceHandleId,
  readSingleWhatsAppTemplateFlowButtonFlowId,
} from "@icecore/scenario-contracts";
import type { FieldErrors } from "react-hook-form";
import type { WhatsAppTemplateRouteRemoval } from "../../builders/whatsapp/template-button-editor-tray";
import {
  translateWhatsAppTemplateEditorError,
  type EditableWhatsAppTemplateButton,
  type EditableWhatsAppTemplateEditorFormValues,
} from "../../builders/whatsapp/template-editor-utils";
import type { ScenarioNodeData, TranslateFn } from "../../types";
import type {
  ScenarioActionConnections,
  ScenarioActionEditorNodeData,
} from "../../view/node-enrichment/types";
import { getWhatsAppTemplateFormSubmittedSourceHandleCopy } from "../../view/scenario-source-handle-copy";
import type {
  ActionNodeBranchState,
  ActionNodeFormSubmittedRoute,
} from "./action-node-state";

type TemplateSectionNodeData = Pick<
  ScenarioActionEditorNodeData,
  | "actionWhatsAppTemplateId"
  | "actionWhatsAppTemplateLanguage"
  | "actionWhatsAppTemplateName"
  | "generatedTemplateDraft"
  | "uiWhatsAppTemplates"
>;

/** The chosen template as the picker and message editor see it. */
export function resolveWhatsAppTemplateSelectionView({
  nodeData,
  selectOpen,
  pendingTemplateValue,
  templatesLoading,
  templatesRefreshing,
}: {
  nodeData: TemplateSectionNodeData;
  selectOpen: boolean;
  pendingTemplateValue: string | null;
  templatesLoading: boolean;
  templatesRefreshing: boolean;
}) {
  const selectedTemplateValue = nodeData.uiWhatsAppTemplates.selectedValue;
  return {
    templatesListLoading: templatesLoading || templatesRefreshing,
    showTemplateSelectLoading:
      (nodeData.uiWhatsAppTemplates.options.length === 0 && templatesLoading) ||
      (selectOpen && templatesRefreshing) ||
      pendingTemplateValue !== null,
    templateSelectValue:
      pendingTemplateValue || selectedTemplateValue || undefined,
    selectedTemplateName: nodeData.actionWhatsAppTemplateName?.trim() || "",
    selectedTemplateLanguage:
      nodeData.actionWhatsAppTemplateLanguage?.trim() || "",
    /** Remounts the message editor when the step points at another template. */
    templateEditorKey: [
      selectedTemplateValue,
      nodeData.actionWhatsAppTemplateId || "",
      nodeData.actionWhatsAppTemplateName || "",
      nodeData.actionWhatsAppTemplateLanguage || "",
    ].join("|"),
  };
}

/**
 * Whether the template is shared from the catalog or could not be verified,
 * which copy of it the Flow health check reads, and how the approved
 * template's reply and form buttons change the step's routes and saved form.
 */
export function resolveWhatsAppTemplateCatalogView({
  catalogMatch,
  hasSelectedOption,
  selectedTemplateId,
  templatesListLoading,
  canSubmitGeneratedTemplate,
  catalogComponents,
  savedComponents,
  savedButtonIds,
  savedForm,
  routedSourceHandleIds,
}: {
  catalogMatch: boolean | undefined;
  hasSelectedOption: boolean;
  selectedTemplateId: string;
  templatesListLoading: boolean;
  canSubmitGeneratedTemplate: boolean;
  catalogComponents: unknown;
  savedComponents: ScenarioNodeData["actionWhatsAppTemplateComponents"];
  savedButtonIds: ScenarioNodeData["actionWhatsAppTemplateButtonIds"];
  /** The saved form fields AI steps read. */
  savedForm: ScenarioNodeData["actionWhatsAppTemplateForm"];
  routedSourceHandleIds: readonly string[];
}) {
  return {
    isSharedTemplate:
      Boolean(catalogMatch) && hasSelectedOption && !canSubmitGeneratedTemplate,
    showUnverifiedTemplate:
      !templatesListLoading &&
      (catalogMatch === false || !hasSelectedOption) &&
      Boolean(selectedTemplateId),
    // Meta sends the template as it is now, not the node's copy.
    flowHealthComponents:
      (catalogMatch && catalogComponents) || savedComponents,
    buttonDrift: catalogMatch
      ? listWhatsAppTemplateButtonDrift({
          nodeData: {
            actionWhatsAppTemplateComponents: savedComponents,
            actionWhatsAppTemplateButtonIds: savedButtonIds,
            actionWhatsAppTemplateForm: savedForm,
          },
          liveComponents: catalogComponents,
          routedSourceHandleIds,
        })
      : [],
  };
}

/**
 * An AI draft goes to review instead of updating a shared template, so it
 * never offers Save.
 */
export function resolveWhatsAppTemplateSaveView({
  generatedTemplateDraft,
  isDirty,
  isSubmitting,
  isUpdatePending,
}: {
  generatedTemplateDraft: TemplateSectionNodeData["generatedTemplateDraft"];
  isDirty: boolean;
  isSubmitting: boolean;
  isUpdatePending: boolean;
}) {
  const canSubmitGeneratedTemplate =
    generatedTemplateDraft?.status === "draft" ||
    generatedTemplateDraft?.status === "rejected";
  const isSavingTemplate = isSubmitting || isUpdatePending;
  return {
    canSubmitGeneratedTemplate,
    isSavingTemplate,
    canSaveTemplate:
      isDirty && !canSubmitGeneratedTemplate && !isSavingTemplate,
  };
}

type SavedTemplateButtonBranches = {
  savedBranchesById: ActionNodeBranchState["savedTemplateButtonBranchesById"];
  buttons: EditableWhatsAppTemplateButton[];
};

/**
 * Saved route options of the message's buttons that no draft row shows,
 * because the author removed the button or changed its type. Save drops their
 * routes. Carousel cards are not edited here, so their routes stay.
 */
function listUnshownTemplateButtonBranches({
  savedBranchesById,
  buttons,
}: SavedTemplateButtonBranches) {
  const shownIds = new Set(
    buttons.flatMap(button =>
      button.type === "quick_reply" && button.routeId !== undefined
        ? [button.routeId]
        : []
    )
  );
  return Array.from(savedBranchesById.values()).filter(
    branch => branch.cardIndex === undefined && !shownIds.has(branch.buttonId)
  );
}

type TemplateFormSubmittedDraft = {
  /** The step's Form submitted route, as its card shows it. */
  formSubmittedRoute: ActionNodeFormSubmittedRoute;
  /** The saved template: its one FLOW button opens the route's form. */
  savedComponents: ScenarioNodeData["actionWhatsAppTemplateComponents"];
  buttons: EditableWhatsAppTemplateButton[];
};

/**
 * The draft's one FLOW row naming a form by id. Save keeps the Form
 * submitted route only while the draft has one, as Meta allows one form
 * button per template.
 */
function readDraftFormButton(buttons: EditableWhatsAppTemplateButton[]) {
  const formButtons = buttons.filter(button => button.type === "flow");
  const [formButton] = formButtons;
  return formButtons.length === 1 &&
    formButton &&
    normalizeEditableTemplateFlowId(formButton.flowId)
    ? formButton
    : null;
}

/**
 * The draft row that draws the Form submitted dot: the template's one FLOW
 * row while it opens the saved form. A row for another form gets the Save
 * hint instead, as a new reply button does.
 */
export function findTemplateFormSubmittedButtonIndex({
  formSubmittedRoute,
  savedComponents,
  buttons,
}: TemplateFormSubmittedDraft): number | null {
  if (formSubmittedRoute.placement !== "row") return null;
  const formButton = readDraftFormButton(buttons);
  return formButton &&
    normalizeEditableTemplateFlowId(formButton.flowId) ===
      readSingleWhatsAppTemplateFlowButtonFlowId(savedComponents)
    ? formButton.index
    : null;
}

/**
 * Saved route handles that no draft row shows, including a linked Form
 * submitted route that no FLOW row draws. Their edges stay anchored until
 * Save.
 */
export function listUnshownTemplateButtonRouteHandles(
  params: SavedTemplateButtonBranches & TemplateFormSubmittedDraft
): string[] {
  const handleIds = listUnshownTemplateButtonBranches(params).map(branch =>
    buildWhatsAppTemplateButtonSourceHandleId(branch.buttonId)
  );
  const { placement, connected } = params.formSubmittedRoute;
  return placement === "row" &&
    connected &&
    findTemplateFormSubmittedButtonIndex(params) === null
    ? [...handleIds, ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID]
    : handleIds;
}

/** A reply step is named by its message, which can be a whole paragraph. */
const REMOVED_ROUTE_STEP_LABEL_MAX_CHARS = 40;
/** The notice ends its own sentence, so a label's closing period would double it. */
const LABEL_CLOSING_PERIOD = /(?<!\.)\.$/;

function shortenStepLabel(label: string): string {
  const text = label.trim().replace(LABEL_CLOSING_PERIOD, "");
  const chars = Array.from(text);
  return chars.length > REMOVED_ROUTE_STEP_LABEL_MAX_CHARS
    ? `${chars
        .slice(0, REMOVED_ROUTE_STEP_LABEL_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

/** Connected routes that Save removes, with the step each one leads to. */
export function listTemplateButtonRoutesRemovedOnSave({
  destinationsBySourceHandle,
  t,
  ...params
}: SavedTemplateButtonBranches &
  TemplateFormSubmittedDraft & {
    destinationsBySourceHandle: ScenarioActionConnections["destinationsBySourceHandle"];
    t: TranslateFn;
  }): WhatsAppTemplateRouteRemoval[] {
  const removals = listUnshownTemplateButtonBranches(params).flatMap(branch => {
    const destination = destinationsBySourceHandle?.get(
      buildWhatsAppTemplateButtonSourceHandleId(branch.buttonId)
    );
    return destination
      ? [
          {
            key: `button:${branch.buttonId}`,
            label: branch.label,
            nextStepLabel: shortenStepLabel(destination.label),
          },
        ]
      : [];
  });
  const formDestination = destinationsBySourceHandle?.get(
    ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID
  );
  return formDestination &&
    params.formSubmittedRoute.placement === "row" &&
    !readDraftFormButton(params.buttons)
    ? [
        ...removals,
        {
          key: "form-submitted",
          label: getWhatsAppTemplateFormSubmittedSourceHandleCopy(t).label,
          nextStepLabel: shortenStepLabel(formDestination.label),
        },
      ]
    : removals;
}

export function translateWhatsAppTemplateEditorErrors(
  errors: FieldErrors<EditableWhatsAppTemplateEditorFormValues>,
  t: TranslateFn
) {
  return {
    header: translateWhatsAppTemplateEditorError(errors.headerText?.message, t),
    body: translateWhatsAppTemplateEditorError(errors.bodyText?.message, t),
    footer: translateWhatsAppTemplateEditorError(errors.footerText?.message, t),
  };
}

/** Button types the template editor can add, with what a tap does. */
export function buildWhatsAppTemplateButtonTypeOptions(t: TranslateFn) {
  return [
    {
      value: "quick_reply" as const,
      label: t("buttonReply"),
      description: t("whatsappTemplateReplyClickHint"),
    },
    {
      value: "url" as const,
      label: t("buttonUrl"),
      description: t("whatsappTemplateUrlClickHint"),
    },
    {
      value: "phone" as const,
      label: t("buttonPhone"),
      description: t("whatsappTemplatePhoneClickHint"),
    },
    {
      value: "flow" as const,
      label: t("buttonFlow"),
      description: t("whatsappTemplateFormClickHint"),
    },
    {
      value: "request_contact_info" as const,
      label: t("buttonContactInfo"),
      description: t("whatsappTemplateContactClickHint"),
    },
  ];
}
