import type { ScenarioPromptInputField } from "@icecore/scenario-contracts";

export type PromptInputRow = { id: number; field: ScenarioPromptInputField };
export type PromptInputRowState = {
  source: ScenarioPromptInputField[] | undefined;
  rows: PromptInputRow[];
  nextId: number;
};

/** Editor-only identity: variable names are editable and blank rows may repeat. */
export function reconcilePromptInputRows(
  fields: ScenarioPromptInputField[] | undefined,
  previous?: PromptInputRowState
): PromptInputRowState {
  let nextId = previous?.nextId ?? 0;
  const remaining = [...(previous?.rows ?? [])];
  const rows = (fields ?? []).map(field => {
    let match = remaining.findIndex(row => row.field === field);
    if (match < 0) {
      // The controlled builder may normalize drafts into fresh objects.
      match = remaining.findIndex(row =>
        row.field.key === field.key &&
        row.field.label === field.label &&
        row.field.prompt === field.prompt
      );
    }
    const previousRow = match < 0 ? undefined : remaining.splice(match, 1)[0];
    return { id: previousRow?.id ?? nextId++, field };
  });
  return { source: fields, rows, nextId };
}
