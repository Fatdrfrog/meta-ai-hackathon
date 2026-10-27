import { normalizeEditableTemplateFlowId } from "@/lib/scenarios/whatsapp-template-flow";
import {
  isWhatsAppFlowGraphId,
  type TemplateFlowFacts,
} from "@/lib/whatsapp/flows/template-flow-health";
import { pickWhatsAppTemplateFlowIdentifier } from "@icecore/shared/types/whatsapp-flows";
import {
  DEFAULT_FLOW_ACTION,
  type EditableWhatsAppTemplateButton,
} from "./template-editor-utils";

/**
 * What the button tray knows about a form's screens, for a form button's
 * first screen:
 * - `loading`: the screens are being read;
 * - `ready`: the form's screen ids, first screen first;
 * - `failed`: they couldn't be read, so the merchant types the screen id;
 * - `manual`: there is no form id to read them by, so the merchant types it.
 */
export type TemplateFlowScreens =
  | { status: "loading" }
  | { status: "ready"; screenIds: readonly string[] }
  | { status: "failed" }
  | { status: "manual" };

/** Screen lookups the template section hands the button tray. */
export type TemplateFlowScreenLookup = {
  screensFor: (flowId: string) => TemplateFlowScreens;
  isRefreshing: (flowId: string) => boolean;
  refresh: (flowId: string) => void;
};

type FormButton = Pick<
  EditableWhatsAppTemplateButton,
  "type" | "flowId" | "flowName" | "flowJson" | "flowAction" | "navigateScreen"
>;

const MANUAL_SCREENS: TemplateFlowScreens = { status: "manual" };
const FAILED_SCREENS: TemplateFlowScreens = { status: "failed" };
const LOADING_SCREENS: TemplateFlowScreens = { status: "loading" };

function opensFirstScreen(button: FormButton): boolean {
  return (
    button.type === "flow" &&
    (button.flowAction || DEFAULT_FLOW_ACTION) === "navigate"
  );
}

/**
 * Whether a form button needs a first screen: it opens a chosen form on a
 * screen. Buttons that load the first screen from the merchant's server
 * ("data_exchange") have none.
 */
export function templateButtonNeedsFirstScreen(button: FormButton): boolean {
  return (
    opensFirstScreen(button) &&
    pickWhatsAppTemplateFlowIdentifier({
      flow_id: button.flowId,
      flow_name: button.flowName,
      flow_json: button.flowJson,
    }) !== null
  );
}

/** The WhatsApp id of the form a button opens on a screen, when it has one. */
function getTemplateButtonScreenFlowId(
  button: FormButton | undefined
): string | null {
  if (!button || !opensFirstScreen(button)) return null;
  const flowId = normalizeEditableTemplateFlowId(button.flowId);
  return isWhatsAppFlowGraphId(flowId) ? flowId : null;
}

/** The form ids whose screens the tray shows. */
export function listTemplateScreenFlowIds(
  buttons: readonly FormButton[]
): string[] {
  return Array.from(
    new Set(
      buttons.flatMap(button => {
        const flowId = getTemplateButtonScreenFlowId(button);
        return flowId ? [flowId] : [];
      })
    )
  );
}

/** The form id of a button that still needs its first screen set. */
export function getTemplateButtonUnsetScreenFlowId(
  button: FormButton | undefined
): string | null {
  return button?.navigateScreen?.trim()
    ? null
    : getTemplateButtonScreenFlowId(button);
}

/** A form's screen ids, first screen first, when WhatsApp returned them. */
export function getTemplateFlowScreenIds(
  facts: TemplateFlowFacts | undefined
): readonly string[] | null {
  if (facts?.state !== "found" || !facts.screenIds?.length) return null;
  return facts.screenIds;
}

/**
 * A form WhatsApp didn't find fails too, and keeps the typed screen id: the
 * lookup reads the workspace's default number, while the form picker lists
 * the scenario's numbers, so the form may live on another one.
 */
export function resolveTemplateFlowScreens(params: {
  flowId: string;
  facts: TemplateFlowFacts | undefined;
  loading: boolean;
}): TemplateFlowScreens {
  if (!isWhatsAppFlowGraphId(params.flowId)) return MANUAL_SCREENS;
  const screenIds = getTemplateFlowScreenIds(params.facts);
  if (screenIds) return { status: "ready", screenIds };
  return params.loading ? LOADING_SCREENS : FAILED_SCREENS;
}

/**
 * What the first screen select lists, and the chosen screen when the list
 * lacks it. It is `missing` once the form's screens loaded without it, like
 * a saved screen the form lost.
 */
export function resolveTemplateFlowScreenChoice(
  value: string,
  screens: TemplateFlowScreens
): { screenIds: readonly string[]; unlisted: string; missing: boolean } {
  const screenIds = screens.status === "ready" ? screens.screenIds : [];
  const unlisted = value && !screenIds.includes(value) ? value : "";
  return {
    screenIds,
    unlisted,
    missing: Boolean(unlisted) && screens.status === "ready",
  };
}

/** The screens a tray row shows; without lookups the merchant types the id. */
export function getTemplateButtonScreens(
  button: FormButton,
  lookup: TemplateFlowScreenLookup | undefined
): TemplateFlowScreens {
  const flowId = normalizeEditableTemplateFlowId(button.flowId);
  return lookup ? lookup.screensFor(flowId) : MANUAL_SCREENS;
}
