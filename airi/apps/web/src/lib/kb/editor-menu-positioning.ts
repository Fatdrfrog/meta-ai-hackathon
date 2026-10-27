export type KbFloatingMenuDecisionInput = {
  isEditable: boolean;
  isFocused: boolean;
  selectionEmpty: boolean;
  isTableActive: boolean;
  parentNodeType: string;
  parentNodeContentSize: number;
};

export function shouldShowKbFloatingMenu(
  _input: KbFloatingMenuDecisionInput
): boolean {
  // The KB editor should expose one contextual menu: the BubbleMenu for
  // selected text. Cursor-only focus creates a second floating toolbar and
  // causes accidental formatting popups, so the FloatingMenu stays disabled.
  return false;
}

export type KbTextBubbleMenuDecisionInput = {
  isEditable: boolean;
  isFocused: boolean;
  selectionEmpty: boolean;
  isTableActive: boolean;
  selectedText: string;
};

export function shouldShowKbTextBubbleMenu({
  isEditable,
  isFocused,
  selectionEmpty,
  selectedText,
}: KbTextBubbleMenuDecisionInput): boolean {
  if (!isEditable) return false;
  if (!isFocused) return false;
  if (selectionEmpty) return false;
  return selectedText.trim().length > 0;
}

export function shouldPortalKbBlockTypeDropdown(_input: {
  compact: boolean;
}): boolean {
  return false;
}
