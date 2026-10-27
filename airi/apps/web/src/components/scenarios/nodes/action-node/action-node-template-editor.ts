"use client";

import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { fetchScenarioWhatsAppFlowDetails } from "@/lib/scenarios/client";
import { normalizeEditableTemplateFlowId } from "@/lib/scenarios/whatsapp-template-flow";
import { getFirstWhatsAppFlowScreenId } from "@/lib/whatsapp/flows/screen-ids";
import { resolveWhatsAppFlowProviderId } from "@icecore/scenario-contracts";
import type { WhatsAppFlowActionType } from "@icecore/shared/types/whatsapp";
import type {
  EditableWhatsAppTemplateButton,
  EditableWhatsAppTemplateButtonType,
  EditableWhatsAppTemplateEditorFormValues,
} from "../../builders/whatsapp/template-editor-utils";

export const DEFAULT_TEMPLATE_FLOW_ACTION = "navigate" as const;
export const EMPTY_EDITABLE_TEMPLATE_BUTTONS: EditableWhatsAppTemplateButton[] =
  [];
export const TEMPLATE_EDITOR_FIELD_UPDATE_OPTIONS = {
  shouldDirty: true,
  shouldTouch: true,
  shouldValidate: true,
} as const;

export type EditableTemplateButtonPatch = {
  label?: string;
  type?: EditableWhatsAppTemplateButtonType;
  value?: string;
  flowId?: string;
  flowName?: string;
  flowJson?: string;
  flowAction?: WhatsAppFlowActionType;
  navigateScreen?: string;
};

export type TemplateEditorUiState = {
  selectOpen: boolean;
  pendingTemplateValue: string | null;
  flowExpanded: boolean;
  openingFlowId: string | null;
};

export type TemplateEditorUiAction =
  | { type: "set-select-open"; open: boolean }
  | { type: "select-template"; value: string }
  | { type: "template-value-synced" }
  | { type: "start-opening-flow"; flowId: string }
  | { type: "finish-opening-flow"; flowId: string }
  | { type: "set-flow-open"; open: boolean };

export function getFirstTemplateEditorErrorMessage(
  error: unknown,
  seen = new WeakSet<object>()
): string | null {
  if (!error || typeof error !== "object") return null;
  if (seen.has(error)) return null;
  seen.add(error);

  const record = error as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }

  for (const value of Object.values(record)) {
    const message = getFirstTemplateEditorErrorMessage(value, seen);
    if (message) return message;
  }

  return null;
}

export function formatTemplateEditorIssuePath(
  path: Array<string | number>
): string {
  return path
    .map(part => (typeof part === "number" ? `[${part}]` : part))
    .join(".");
}
export const INITIAL_TEMPLATE_EDITOR_UI_STATE: TemplateEditorUiState = {
  selectOpen: false,
  pendingTemplateValue: null,
  flowExpanded: false,
  openingFlowId: null,
};

export function reduceTemplateEditorUiState(
  state: TemplateEditorUiState,
  action: TemplateEditorUiAction
): TemplateEditorUiState {
  switch (action.type) {
    case "set-select-open":
      return state.selectOpen === action.open
        ? state
        : {
            ...state,
            selectOpen: action.open,
          };
    case "select-template":
      return {
        ...state,
        selectOpen: false,
        pendingTemplateValue: action.value,
        flowExpanded: false,
        openingFlowId: null,
      };
    case "template-value-synced":
      if (
        !state.selectOpen &&
        state.pendingTemplateValue === null &&
        !state.flowExpanded &&
        state.openingFlowId === null
      ) {
        return state;
      }
      return INITIAL_TEMPLATE_EDITOR_UI_STATE;
    case "start-opening-flow":
      return {
        ...state,
        selectOpen: false,
        openingFlowId: action.flowId,
      };
    case "finish-opening-flow":
      return state.openingFlowId === action.flowId
        ? {
            ...state,
            openingFlowId: null,
          }
        : state;
    case "set-flow-open":
      return {
        ...state,
        flowExpanded: action.open,
        openingFlowId: action.open ? state.openingFlowId : null,
      };
  }
}

export function createEditableTemplateButton(
  index: number
): EditableWhatsAppTemplateButton {
  return {
    index,
    label: "",
    type: "quick_reply",
  };
}

function getFirstConfiguredFlowScreenId(
  flowConfig: WhatsAppFlowConfig | null | undefined,
  flowId: string
): string | null {
  if (!flowConfig) return null;
  if (resolveWhatsAppFlowProviderId({ flowConfig }) !== flowId) {
    return null;
  }

  const screen = flowConfig.screens.find(item => item.id.trim().length > 0);
  return screen?.id.trim() || null;
}

export async function resolveMissingTemplateFlowNavigateScreens({
  values,
  workspaceId,
  flowConfig,
  nodeId,
}: {
  values: EditableWhatsAppTemplateEditorFormValues;
  workspaceId: string;
  flowConfig: WhatsAppFlowConfig | null | undefined;
  nodeId: string;
}): Promise<EditableWhatsAppTemplateEditorFormValues> {
  let changed = false;
  const buttons = await Promise.all(
    values.buttons.map(async button => {
      if (button.type !== "flow") return button;

      const flowId = normalizeEditableTemplateFlowId(button.flowId);
      const flowAction = button.flowAction || DEFAULT_TEMPLATE_FLOW_ACTION;
      if (
        flowAction !== "navigate" ||
        !flowId ||
        button.navigateScreen?.trim()
      ) {
        return button;
      }

      const configuredScreen = getFirstConfiguredFlowScreenId(
        flowConfig,
        flowId
      );
      if (configuredScreen) {
        changed = true;
        return { ...button, navigateScreen: configuredScreen };
      }

      if (!workspaceId) return button;

      try {
        const details = await fetchScenarioWhatsAppFlowDetails({
          workspaceId,
          flowId,
        });
        const firstScreen = getFirstWhatsAppFlowScreenId(details.flowJson);
        if (!firstScreen) {
          console.warn(
            "[Scenarios] WhatsApp template flow navigate screen not found",
            {
              nodeId,
              flowId,
              flowJsonError: details.flowJsonError ?? null,
            }
          );
          return button;
        }

        changed = true;
        return { ...button, navigateScreen: firstScreen };
      } catch (error) {
        console.warn(
          "[Scenarios] WhatsApp template flow navigate screen lookup failed",
          {
            nodeId,
            flowId,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return button;
      }
    })
  );

  return changed ? { ...values, buttons } : values;
}

/** Renumbers the rows; each keeps its route id, so routes follow the button. */
export function reindexEditableTemplateButtons(
  buttons: EditableWhatsAppTemplateButton[]
): EditableWhatsAppTemplateButton[] {
  return buttons.map((button, index) => ({
    ...button,
    index,
  }));
}

/** A type change keeps the row's route id, so switching back keeps its route. */
export function applyEditableTemplateButtonPatch(
  button: EditableWhatsAppTemplateButton,
  patch: EditableTemplateButtonPatch
): EditableWhatsAppTemplateButton {
  const next = patchEditableTemplateButtonFields(button, patch);
  return button.routeId === undefined
    ? next
    : { ...next, routeId: button.routeId };
}

function patchEditableTemplateButtonFields(
  button: EditableWhatsAppTemplateButton,
  patch: EditableTemplateButtonPatch
): EditableWhatsAppTemplateButton {
  const nextType = patch.type ?? button.type;
  const changedType = patch.type !== undefined && patch.type !== button.type;
  const label = patch.label ?? button.label ?? "";

  if (nextType === "url") {
    return {
      index: button.index,
      label,
      type: "url",
      value: changedType ? "" : (patch.value ?? button.value ?? ""),
      ...(!changedType && button.example ? { example: button.example } : {}),
    };
  }

  if (nextType === "phone") {
    return {
      index: button.index,
      label,
      type: "phone",
      value: changedType ? "" : (patch.value ?? button.value ?? ""),
    };
  }

  if (nextType === "flow") {
    const changedFlow =
      patch.flowId !== undefined && patch.flowId !== button.flowId;
    return {
      index: button.index,
      label,
      type: "flow",
      flowId: changedType ? "" : (patch.flowId ?? button.flowId ?? ""),
      flowName:
        changedType || changedFlow
          ? undefined
          : (patch.flowName ?? button.flowName),
      flowJson:
        changedType || changedFlow
          ? undefined
          : (patch.flowJson ?? button.flowJson),
      flowAction: changedType
        ? DEFAULT_TEMPLATE_FLOW_ACTION
        : (patch.flowAction ??
          button.flowAction ??
          DEFAULT_TEMPLATE_FLOW_ACTION),
      navigateScreen:
        changedType || changedFlow
          ? undefined
          : (patch.navigateScreen ?? button.navigateScreen),
    };
  }

  if (nextType === "request_contact_info") {
    return {
      index: button.index,
      label: "",
      type: "request_contact_info",
    };
  }

  return {
    index: button.index,
    label,
    type: nextType === "copy_code" ? "copy_code" : "quick_reply",
    ...(!changedType && button.example ? { example: button.example } : {}),
  };
}
