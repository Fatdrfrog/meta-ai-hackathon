import {
  applyEditableTemplateButtonPatch,
  resolveMissingTemplateFlowNavigateScreens,
} from "./action-node-template-editor";

it("preserves an existing copy-code action when its label changes", () => {
  expect(
    applyEditableTemplateButtonPatch(
      { index: 0, type: "copy_code", label: "Copy" },
      { label: "Copy code" }
    )
  ).toEqual({ index: 0, type: "copy_code", label: "Copy code" });
});

it("clears the previous Flow screen and alternate identifiers when selecting another Flow", () => {
  const result = applyEditableTemplateButtonPatch(
    {
      index: 0,
      type: "flow",
      label: "Open",
      flowId: "old",
      flowName: "Old flow",
      navigateScreen: "OLD_SCREEN",
    },
    { flowId: "new" }
  );
  expect(result.flowId).toBe("new");
  expect(result.navigateScreen).toBeUndefined();
  expect(result.flowName).toBeUndefined();
});

it("keeps URL variable examples when editing the label", () => {
  const result = applyEditableTemplateButtonPatch(
    {
      index: 0,
      type: "url",
      label: "Open",
      value: "https://example.com/{{1}}",
      example: ["https://example.com/shop"],
    },
    { label: "Shop" }
  );
  expect(result.example).toEqual(["https://example.com/shop"]);
});

it("uses managed Flow screens for a matching template button", async () => {
  const result = await resolveMissingTemplateFlowNavigateScreens({
    values: {
      headerText: "",
      bodyText: "Complete the form",
      footerText: "",
      buttons: [
        {
          index: 0,
          label: "Open flow",
          type: "flow",
          flowId: "managed-flow-id",
          flowAction: "navigate",
        },
      ],
    },
    workspaceId: "",
    nodeId: "action-1",
    flowConfig: {
      templateId: "local-flow",
      ctaText: "Open flow",
      metaFlowId: "stale-meta-flow-id",
      managedProvisioning: {
        operationId: "operation-1",
        sourceId: "source-1",
        wabaId: "waba-1",
        contentRevision: 2,
        contentDigest: "digest-2",
        flowId: "managed-flow-id",
        providerStatus: "PUBLISHED",
      },
      screens: [{ id: "DETAILS", title: "Details", fields: [] }],
    },
  });

  expect(result.buttons[0]?.navigateScreen).toBe("DETAILS");
});
