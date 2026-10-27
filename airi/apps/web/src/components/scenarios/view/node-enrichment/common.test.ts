import {
  buildCommonNodeEnrichment,
  buildSourceHandleEnrichment,
} from "./common";

describe("common node enrichment", () => {
  it("bridges persisted patches, removal, and source-handle creation by node id", () => {
    const updateNodeById = jest.fn();
    const removeNodeById = jest.fn();
    const openNodePickerFromHandle = jest.fn();
    const ctx = {
      callbacksRef: {
        current: { updateNodeById, removeNodeById },
      },
      openNodePickerFromHandle,
    } as never;

    const common = buildCommonNodeEnrichment("action-1", ctx);
    const sourceHandle = buildSourceHandleEnrichment("action-1", ctx);

    common.uiOnPatch({ actionReplyText: "Hello" });
    common.uiOnRemove();
    sourceHandle.uiOnCreateNodeFromSourceHandle("right-source", 120, 240);

    expect(updateNodeById).toHaveBeenCalledWith("action-1", {
      actionReplyText: "Hello",
    });
    expect(removeNodeById).toHaveBeenCalledWith("action-1");
    expect(openNodePickerFromHandle).toHaveBeenCalledWith(
      "action-1",
      "right-source",
      120,
      240
    );
  });

  it("opens node settings through selection and records keyboard focus requests", () => {
    const selectNodeById = jest.fn();
    const nodeSettingsFocusRequestRef = { current: null as string | null };
    const ctx = {
      callbacksRef: { current: { selectNodeById } },
      nodeSettingsFocusRequestRef,
      nodeSettingsPanelEnabled: true,
    };

    const common = buildCommonNodeEnrichment("trigger-1", ctx as never);
    expect(common.uiUsesSettingsPanel).toBe(true);
    common.uiOnOpenSettings?.({ moveFocus: true });
    expect(nodeSettingsFocusRequestRef.current).toBe("trigger-1");
    expect(selectNodeById).toHaveBeenLastCalledWith("trigger-1");
    // A pointer open replaces an earlier keyboard request.
    common.uiOnOpenSettings?.({ moveFocus: false });
    expect(nodeSettingsFocusRequestRef.current).toBeNull();
    expect(selectNodeById).toHaveBeenCalledTimes(2);

    expect(
      buildCommonNodeEnrichment("trigger-1", {
        ...ctx,
        nodeSettingsPanelEnabled: false,
      } as never).uiUsesSettingsPanel
    ).toBe(false);
  });
});
