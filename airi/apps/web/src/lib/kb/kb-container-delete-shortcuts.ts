import { Extension } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

export const KB_CONTAINER_NODE_NAMES = ["table", "kbGrid"] as const;

export function isKBContainerNodeName(
  nodeName: string
): nodeName is (typeof KB_CONTAINER_NODE_NAMES)[number] {
  return KB_CONTAINER_NODE_NAMES.includes(
    nodeName as (typeof KB_CONTAINER_NODE_NAMES)[number]
  );
}

export const KBContainerDeleteShortcuts = Extension.create({
  name: "kbContainerDeleteShortcuts",

  addKeyboardShortcuts() {
    const deleteSelectedContainer = () => {
      const { selection } = this.editor.state;
      if (
        selection instanceof NodeSelection &&
        isKBContainerNodeName(selection.node.type.name)
      ) {
        return this.editor.commands.deleteSelection();
      }

      return false;
    };

    return {
      Backspace: deleteSelectedContainer,
      Delete: deleteSelectedContainer,
    };
  },
});
