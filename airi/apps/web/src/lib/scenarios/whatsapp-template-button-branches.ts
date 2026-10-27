import type { WhatsAppComponent } from "@icecore/shared/types/whatsapp";
import {
  ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID,
  buildWhatsAppTemplateButtonPayload,
  buildWhatsAppTemplateButtonSourceHandleId,
  listWhatsAppTemplateQuickReplyButtons,
  normalizeWhatsAppTemplateButtonText,
  readSingleWhatsAppTemplateFlowButton,
  reconcileSentWhatsAppTemplateButtons,
  rekeyStoredWhatsAppTemplateButtonIds,
  resolveWhatsAppTemplateButtons,
  type ScenarioNodeData,
  type WhatsAppTemplateButtonRekeyMatch,
} from "@icecore/scenario-contracts";
import { readSavedWhatsAppTemplateForm } from "./whatsapp-template-form-snapshot";

export type WhatsAppTemplateButtonBranchOption = {
  /** The step's id for the button, carried by its route handle and payload. */
  buttonId: number;
  /** Position in the BUTTONS component. */
  index: number;
  /** Set for a carousel card's button: the card's position in the carousel. */
  cardIndex?: number;
  payload: string;
  label: string;
};

/** The step's saved template and the ids of its quick replies. */
export type WhatsAppTemplateButtonBranchNodeData = Pick<
  ScenarioNodeData,
  "actionWhatsAppTemplateComponents" | "actionWhatsAppTemplateButtonIds"
>;

function normalizeActionNodeId(actionNodeId: string): string {
  return actionNodeId.trim();
}

/** Route options for the step's quick replies; a button without an id has none. */
export function extractWhatsAppTemplateQuickReplyBranchOptions(params: {
  actionNodeId: string;
  nodeData: WhatsAppTemplateButtonBranchNodeData;
}): WhatsAppTemplateButtonBranchOption[] {
  const actionNodeId = normalizeActionNodeId(params.actionNodeId);
  if (!actionNodeId) return [];

  return resolveWhatsAppTemplateButtons(
    params.nodeData.actionWhatsAppTemplateComponents,
    params.nodeData.actionWhatsAppTemplateButtonIds
  ).flatMap(({ id, index, label, cardIndex }) =>
    id === null
      ? []
      : [
          {
            buttonId: id,
            index,
            ...(cardIndex === undefined ? {} : { cardIndex }),
            label,
            payload: buildWhatsAppTemplateButtonPayload(actionNodeId, id),
          },
        ]
  );
}

/**
 * The node patch that stores the button ids for a step's next template. It is
 * empty when the step keeps its stored ids as they are.
 */
export function buildWhatsAppTemplateButtonIdsPatch(params: {
  /** The step's current template, as the builder shows it, and its ids. */
  previous: WhatsAppTemplateButtonBranchNodeData;
  components: WhatsAppComponent[] | null | undefined;
  match: WhatsAppTemplateButtonRekeyMatch;
}): Pick<ScenarioNodeData, "actionWhatsAppTemplateButtonIds"> {
  const buttonIds = rekeyStoredWhatsAppTemplateButtonIds({
    previous: {
      components: params.previous.actionWhatsAppTemplateComponents,
      buttonIds: params.previous.actionWhatsAppTemplateButtonIds,
    },
    components: params.components,
    match: params.match,
  });
  return buttonIds ? { actionWhatsAppTemplateButtonIds: buttonIds } : {};
}

/**
 * How the approved template in WhatsApp changes the step's routes and the
 * form answers its AI steps read. `label` is the step's text, except for
 * `added`, where it is the approved template's. `cardIndex` names a carousel
 * card's button. The `form_` kinds are the saved form button's: the approved
 * template has no one form button (`form_removed` while the "Form submitted"
 * route is linked, else `form_answers_removed`), or its form button opens
 * another form.
 */
export type WhatsAppTemplateButtonDrift = { cardIndex?: number } & (
  | {
      kind:
        | "removed"
        | "added"
        | "form_removed"
        | "form_answers_removed"
        | "form_changed";
      label: string;
    }
  | { kind: "renamed"; label: string; liveLabel: string }
);

function withDriftCard<T extends WhatsAppTemplateButtonDrift>(
  drift: T,
  cardIndex: number | undefined
): T {
  return cardIndex === undefined ? drift : { ...drift, cardIndex };
}

/** The step's saved template, the ids of its quick replies and its form. */
type WhatsAppTemplateDriftNodeData = WhatsAppTemplateButtonBranchNodeData &
  Pick<ScenarioNodeData, "actionWhatsAppTemplateForm">;

/**
 * The "Form submitted" route, and AI steps through the step's saved form
 * fields, wait for the form that the saved template's one FLOW button opens,
 * but WhatsApp sends the approved template: without one form button there
 * the route can't run and no answers come, and with another form its answers
 * aren't the ones the saved fields list. A step with neither the route nor
 * saved fields for that form has none. Named by the saved button's text.
 */
function listWhatsAppTemplateFormButtonDrift(
  nodeData: WhatsAppTemplateDriftNodeData,
  liveComponents: unknown,
  formRouted: boolean
): WhatsAppTemplateButtonDrift[] {
  const saved = readSingleWhatsAppTemplateFlowButton(
    nodeData.actionWhatsAppTemplateComponents
  );
  if (
    !saved ||
    (!formRouted && !readSavedWhatsAppTemplateForm(nodeData, saved.flowId))
  ) {
    return [];
  }
  const live = readSingleWhatsAppTemplateFlowButton(liveComponents);
  if (!live) {
    return [
      {
        kind: formRouted ? "form_removed" : "form_answers_removed",
        label: saved.text,
      },
    ];
  }
  return live.flowId === saved.flowId
    ? []
    : [{ kind: "form_changed", label: saved.text }];
}

/**
 * Where the approved template's buttons move the step's routes away from its
 * saved copy. Reply buttons are paired the way sends pair them, so a routed
 * button can lose its pairing or pair with another text, and an approved
 * button can have no route. A button that only moved keeps its route. A
 * linked "Form submitted" route, and the saved form fields AI steps read,
 * follow the one FLOW button's form. A step with no reply-button route, no
 * "Form submitted" route and no saved form fields, or with no saved copy, has
 * none.
 */
export function listWhatsAppTemplateButtonDrift(params: {
  nodeData: WhatsAppTemplateDriftNodeData;
  liveComponents: unknown;
  /** Source handles of the step's edges. */
  routedSourceHandleIds: Iterable<string>;
}): WhatsAppTemplateButtonDrift[] {
  const { liveComponents } = params;
  if (!Array.isArray(liveComponents) || liveComponents.length === 0) {
    return [];
  }
  const routedHandles = new Set(params.routedSourceHandleIds);
  const formDrift = listWhatsAppTemplateFormButtonDrift(
    params.nodeData,
    liveComponents,
    routedHandles.has(ACTION_WHATSAPP_TEMPLATE_FORM_SUBMITTED_HANDLE_ID)
  );
  const stepButtons = resolveWhatsAppTemplateButtons(
    params.nodeData.actionWhatsAppTemplateComponents,
    params.nodeData.actionWhatsAppTemplateButtonIds
  );
  const routedButtons = stepButtons.filter(
    button =>
      button.id !== null &&
      routedHandles.has(buildWhatsAppTemplateButtonSourceHandleId(button.id))
  );
  if (routedButtons.length === 0) return formDrift;

  const liveButtons = reconcileSentWhatsAppTemplateButtons(
    listWhatsAppTemplateQuickReplyButtons(liveComponents),
    stepButtons
  );
  const changes = routedButtons.flatMap(
    (button): WhatsAppTemplateButtonDrift[] => {
      const live = liveButtons.find(item => item.id === button.id);
      if (!live) {
        return [
          withDriftCard(
            { kind: "removed", label: button.label },
            button.cardIndex
          ),
        ];
      }
      return normalizeWhatsAppTemplateButtonText(live.label) ===
        normalizeWhatsAppTemplateButtonText(button.label)
        ? []
        : [
            withDriftCard(
              { kind: "renamed", label: button.label, liveLabel: live.label },
              button.cardIndex
            ),
          ];
    }
  );
  const added = liveButtons.flatMap((button): WhatsAppTemplateButtonDrift[] =>
    button.id === null
      ? [
          withDriftCard(
            { kind: "added", label: button.label },
            button.cardIndex
          ),
        ]
      : []
  );
  return [...changes, ...added, ...formDrift];
}

function hasQuickReply(component: { type: string; buttons?: unknown }) {
  return (
    component.type === "BUTTONS" &&
    Array.isArray(component.buttons) &&
    component.buttons.some(
      button =>
        typeof button === "object" &&
        button !== null &&
        (button as { type?: unknown }).type === "QUICK_REPLY"
    )
  );
}

/** Whether the message or one of its carousel cards has a quick reply. */
export function hasWhatsAppTemplateQuickReplyButtons(
  components: WhatsAppComponent[] | null | undefined
): boolean {
  if (!Array.isArray(components)) return false;
  return components.some(
    component =>
      hasQuickReply(component) ||
      (component.type === "CAROUSEL" &&
        Array.isArray(component.cards) &&
        component.cards.some(
          card =>
            Array.isArray(card?.components) &&
            card.components.some(hasQuickReply)
        ))
  );
}
