/** @jest-environment jsdom */

import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { useWhatsAppTemplateControls } from "./use-whatsapp-template-controls";

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

type ControlsInput = Parameters<typeof useWhatsAppTemplateControls>[0];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const FLOW_CONFIG: WhatsAppFlowConfig = {
  templateId: "flow-template",
  ctaText: "Open flow",
  screens: [{ id: "START", title: "Start", fields: [] }],
  providerReference: {
    flowId: "flow-a",
    sourceId: "source-a",
    wabaId: "waba-a",
    providerStatus: "PUBLISHED",
  },
};

type InputOverrides = {
  nodeData?: Partial<ControlsInput["nodeData"]>;
  mode?: Partial<ControlsInput["mode"]>;
  templates?: ControlsInput["nodeData"]["uiWhatsAppTemplates"];
  flows?: ControlsInput["nodeData"]["uiWhatsAppFlows"];
  patchNode?: ControlsInput["patchNode"];
};

function createInput(overrides: InputOverrides = {}): ControlsInput {
  const templates = overrides.templates ?? {
    options: [],
    selectedValue: "template-a|en_US",
    onOpenChange: jest.fn(),
    select: jest.fn(),
  };
  const flows = overrides.flows ?? {
    options: [
      { id: "flow-a", name: "A", sourceId: "source-a" },
      { id: "flow-a", name: "Other A", sourceId: "source-b" },
    ],
    openPicker: jest.fn(),
    select: jest.fn().mockResolvedValue(undefined),
  };
  const input: ControlsInput = {
    id: "action-a",
    nodeData: {
      actionWhatsAppTemplateId: "template-a",
      actionWhatsAppTemplateName: "welcome",
      actionWhatsAppTemplateLanguage: "en_US",
      actionWhatsAppTemplateComponents: [
        {
          type: "BUTTONS",
          buttons: [{ type: "FLOW", text: "Open", flow_id: "flow-a" }],
        },
      ],
      actionFlowConfig: null,
      actionReplyCtaFlowId: undefined,
      uiActiveScenarioId: "scenario-a",
      uiWhatsAppTemplates: templates,
      uiWhatsAppFlows: flows,
      ...overrides.nodeData,
    },
    mode: {
      templateEditorWorkspaceId: "workspace-a",
      canEditTemplateFlow: true,
      isWhatsAppTemplateAction: true,
      ...overrides.mode,
    },
    patchNode: jest.fn(),
    flowExistingLoadFailedMessage: "Could not load flow",
  };
  return {
    ...input,
    ...(overrides.patchNode ? { patchNode: overrides.patchNode } : {}),
  };
}

describe("useWhatsAppTemplateControls", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not reopen for a delayed A request after an A to B to A visit", async () => {
    const pending = deferred();
    const input = createInput({
      flows: {
        ...createInput().nodeData.uiWhatsAppFlows,
        options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
        select: jest.fn().mockReturnValue(pending.promise),
      },
    });
    const { result, rerender } = renderHook(
      (props: ControlsInput) => useWhatsAppTemplateControls(props),
      { initialProps: input }
    );

    act(() => void result.current.openInlineFlow("flow-a"));
    rerender({
      ...input,
      nodeData: { ...input.nodeData, actionWhatsAppTemplateId: "template-b" },
    });
    rerender(input);
    await act(async () => pending.resolve());

    expect(result.current.flowDrawerOpen).toBe(false);
    expect(result.current.openingFlowId).toBeNull();
  });

  it("lets close and a newer same-id request supersede delayed completions", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const select = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { result } = renderHook(() =>
      useWhatsAppTemplateControls(
        createInput({
          flows: {
            ...createInput().nodeData.uiWhatsAppFlows,
            options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
            select,
          },
        })
      )
    );

    act(() => void result.current.openInlineFlow("flow-a"));
    act(() => result.current.closeInlineFlow());
    await act(async () => first.resolve());
    expect(result.current.flowDrawerOpen).toBe(false);

    act(() => void result.current.openInlineFlow("flow-a"));
    act(() => void result.current.openInlineFlow("flow-a"));
    await act(async () => second.resolve());
    expect(result.current.flowDrawerOpen).toBe(false);
    await act(async () => third.resolve());
    expect(result.current.flowDrawerOpen).toBe(true);
  });

  it("ignores stale errors but clears an active rejection so it can retry", async () => {
    const stale = deferred();
    const active = deferred();
    const select = jest
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(active.promise)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() =>
      useWhatsAppTemplateControls(
        createInput({
          flows: {
            ...createInput().nodeData.uiWhatsAppFlows,
            options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
            select,
          },
        })
      )
    );

    act(() => void result.current.openInlineFlow("flow-a"));
    act(() => void result.current.openInlineFlow("flow-a"));
    await act(async () => stale.reject(new Error("stale")));
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.openingFlowId).toBe("flow-a");

    await act(async () => active.reject(new Error("active")));
    // The localized message only; the server text never reaches the toast.
    expect(toast.error).toHaveBeenCalledWith("Could not load flow");
    expect(toast.error).not.toHaveBeenCalledWith("active", expect.anything());
    expect(result.current.openingFlowId).toBeNull();

    await act(async () => result.current.openInlineFlow("flow-a"));
    expect(result.current.flowDrawerOpen).toBe(true);
  });

  it("keeps a current successful attachment open across matching config updates", async () => {
    const pending = deferred();
    const input = createInput({
      flows: {
        ...createInput().nodeData.uiWhatsAppFlows,
        options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
        select: jest.fn().mockReturnValue(pending.promise),
      },
    });
    const { result, rerender } = renderHook(
      (props: ControlsInput) => useWhatsAppTemplateControls(props),
      { initialProps: input }
    );

    act(() => void result.current.openInlineFlow("flow-a"));
    rerender({
      ...input,
      nodeData: { ...input.nodeData, actionFlowConfig: FLOW_CONFIG },
    });
    await act(async () => pending.resolve());

    expect(result.current.flowDrawerOpen).toBe(true);
    expect(result.current.inlineFlowConfig).toEqual(FLOW_CONFIG);
  });

  it.each([
    [
      "selected template value",
      (input: ControlsInput): ControlsInput => ({
        ...input,
        nodeData: {
          ...input.nodeData,
          uiWhatsAppTemplates: {
            ...input.nodeData.uiWhatsAppTemplates,
            selectedValue: "template-b|en_US",
          },
        },
      }),
    ],
    [
      "Flow eligibility",
      (input: ControlsInput): ControlsInput => ({
        ...input,
        mode: { ...input.mode, canEditTemplateFlow: false },
      }),
    ],
    [
      "embedded Flow identity",
      (input: ControlsInput): ControlsInput => ({
        ...input,
        nodeData: {
          ...input.nodeData,
          actionWhatsAppTemplateComponents: [
            {
              type: "BUTTONS",
              buttons: [{ type: "FLOW", text: "Open", flow_id: "flow-b" }],
            },
          ],
        },
      }),
    ],
  ])(
    "invalidates a delayed open when %s changes",
    async (_label, transition) => {
      const pending = deferred();
      const input = createInput({
        flows: {
          ...createInput().nodeData.uiWhatsAppFlows,
          options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
          select: jest.fn().mockReturnValue(pending.promise),
        },
      });
      const { result, rerender } = renderHook(
        (props: ControlsInput) => useWhatsAppTemplateControls(props),
        { initialProps: input }
      );

      act(() => void result.current.openInlineFlow("flow-a"));
      rerender(transition(input));
      await act(async () => pending.resolve());

      expect(result.current.flowDrawerOpen).toBe(false);
      expect(result.current.openingFlowId).toBeNull();
    }
  );

  it("ignores a retained open command from an earlier template visit", async () => {
    const select = jest.fn().mockResolvedValue(undefined);
    const openPicker = jest.fn();
    const onOpenChange = jest.fn();
    const input = createInput({
      templates: {
        ...createInput().nodeData.uiWhatsAppTemplates,
        onOpenChange,
      },
      flows: {
        ...createInput().nodeData.uiWhatsAppFlows,
        options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
        select,
        openPicker,
      },
    });
    const { result, rerender } = renderHook(
      (props: ControlsInput) => useWhatsAppTemplateControls(props),
      { initialProps: input }
    );
    const retainedOpen = result.current.openInlineFlow;
    rerender({
      ...input,
      nodeData: { ...input.nodeData, actionWhatsAppTemplateId: "template-b" },
    });

    await act(async () => retainedOpen("flow-a"));

    expect(select).not.toHaveBeenCalled();
    expect(openPicker).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(result.current.openingFlowId).toBeNull();
    expect(result.current.flowDrawerOpen).toBe(false);
  });

  it("suppresses a pending rejection after unmount", async () => {
    const pending = deferred();
    const input = createInput({
      flows: {
        ...createInput().nodeData.uiWhatsAppFlows,
        options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
        select: jest.fn().mockReturnValue(pending.promise),
      },
    });
    const { result, unmount } = renderHook(() =>
      useWhatsAppTemplateControls(input)
    );

    act(() => void result.current.openInlineFlow("flow-a"));
    unmount();
    await act(async () => pending.reject(new Error("late rejection")));

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("selects the source-bound flow and falls back to the picker when ambiguous", async () => {
    const select = jest.fn().mockResolvedValue(undefined);
    const openPicker = jest.fn();
    const { result, rerender } = renderHook(
      (props: ControlsInput) => useWhatsAppTemplateControls(props),
      {
        initialProps: createInput({
          nodeData: { actionFlowConfig: FLOW_CONFIG },
          flows: {
            ...createInput().nodeData.uiWhatsAppFlows,
            select,
            openPicker,
          },
        }),
      }
    );

    await act(async () => result.current.openInlineFlow("flow-a"));
    expect(select).not.toHaveBeenCalled();

    rerender(
      createInput({
        nodeData: {
          actionFlowConfig: {
            ...FLOW_CONFIG,
            providerReference: {
              flowId: "flow-other",
              sourceId: "source-a",
              wabaId: "waba-a",
              providerStatus: "PUBLISHED",
            },
          },
        },
        flows: {
          ...createInput().nodeData.uiWhatsAppFlows,
          select,
          openPicker,
        },
      })
    );
    await act(async () => result.current.openInlineFlow("flow-a"));
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flow-a", sourceId: "source-a" })
    );

    rerender(
      createInput({
        flows: {
          options: [
            { id: "flow-a", name: "A", sourceId: "source-a" },
            { id: "flow-a", name: "Other A", sourceId: "source-b" },
          ],
          select,
          openPicker,
        },
      })
    );
    await act(async () => result.current.openInlineFlow("flow-a"));
    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(result.current.flowDrawerOpen).toBe(true);
  });

  it("invalidates immediately on template selection and preserves sanitized patch semantics", async () => {
    const pending = deferred();
    const selectTemplate = jest.fn();
    const patchNode = jest.fn();
    const { result } = renderHook(() =>
      useWhatsAppTemplateControls(
        createInput({
          templates: {
            ...createInput().nodeData.uiWhatsAppTemplates,
            select: selectTemplate,
          },
          flows: {
            ...createInput().nodeData.uiWhatsAppFlows,
            options: [createInput().nodeData.uiWhatsAppFlows.options[0]],
            select: jest.fn().mockReturnValue(pending.promise),
          },
          patchNode,
        })
      )
    );

    act(() => void result.current.openInlineFlow("flow-a"));
    act(() => result.current.selectTemplate("template-b|en_US"));
    await act(async () => pending.resolve());
    expect(result.current.flowDrawerOpen).toBe(false);
    expect(selectTemplate).toHaveBeenCalledWith("template-b|en_US");

    act(() =>
      result.current.changeInlineFlowConfig({
        ...FLOW_CONFIG,
        ctaText: "  A label longer than thirty characters exactly  ",
      })
    );
    expect(patchNode).toHaveBeenCalledWith(
      expect.objectContaining({
        actionReplyCtaType: "flow",
        actionReplyCtaFlowId: "flow-a",
        actionReplyCtaLabel: "A label longer than thirty cha",
      })
    );
    await waitFor(() => expect(result.current.openingFlowId).toBeNull());
  });
});
