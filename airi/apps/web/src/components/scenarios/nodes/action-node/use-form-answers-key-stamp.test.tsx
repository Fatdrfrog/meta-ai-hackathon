/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";
import type { WhatsAppFlowConfig } from "@/components/scenarios/types";
import { useFormAnswersKeyStamp } from "./use-form-answers-key-stamp";

const emptyForm: WhatsAppFlowConfig = {
  templateId: "",
  screens: [],
  ctaText: "",
};

const leadForm: WhatsAppFlowConfig = {
  templateId: "lead_generation",
  ctaText: "Open",
  screens: [
    {
      id: "LEAD_FORM",
      title: "Your details",
      fields: [{ id: "name", label: "Name", fieldType: "TextInput" }],
    },
  ],
};

describe("useFormAnswersKeyStamp", () => {
  it("names a form made from a ready form when the builder first saves it", () => {
    const onFlowConfigChange = jest.fn();
    const { result } = renderHook(() =>
      useFormAnswersKeyStamp({
        nodeId: "new",
        // An empty new form has no key yet; another form has "lead_generation".
        formKeysByNodeId: new Map([["other", "lead_generation"]]),
        flowConfig: emptyForm,
        onFlowConfigChange,
      })
    );

    result.current.commitFlowConfig(leadForm);

    expect(onFlowConfigChange).toHaveBeenCalledWith({
      ...leadForm,
      answersKey: "lead_generation_2",
    });
  });

  it("shows an unnamed form with the key its step has and keeps it on every change", () => {
    const onFlowConfigChange = jest.fn();
    const { result } = renderHook(() =>
      useFormAnswersKeyStamp({
        nodeId: "legacy",
        formKeysByNodeId: new Map([["legacy", "form_2"]]),
        flowConfig: leadForm,
        onFlowConfigChange,
      })
    );

    expect(result.current.flowConfig?.answersKey).toBe("form_2");
    expect(result.current.answerTokens.get("name")).toBe(
      "{{form.form_2.name}}"
    );

    // A new ready form replaces the config; the step keeps its key.
    result.current.commitFlowConfig({ ...leadForm, templateId: "survey" });
    expect(onFlowConfigChange).toHaveBeenLastCalledWith({
      ...leadForm,
      templateId: "survey",
      answersKey: "form_2",
    });
  });

  it("passes the form through outside a scenario graph", () => {
    const onFlowConfigChange = jest.fn();
    const { result } = renderHook(() =>
      useFormAnswersKeyStamp({
        nodeId: "node",
        formKeysByNodeId: undefined,
        flowConfig: leadForm,
        onFlowConfigChange,
      })
    );

    expect(result.current.flowConfig).toBe(leadForm);
    expect(result.current.answerTokens.size).toBe(0);
    result.current.commitFlowConfig(leadForm);
    expect(onFlowConfigChange).toHaveBeenCalledWith(leadForm);
  });
});
