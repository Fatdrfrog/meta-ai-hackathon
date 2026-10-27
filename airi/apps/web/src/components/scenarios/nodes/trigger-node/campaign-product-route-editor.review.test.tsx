/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { CampaignProductRouteEditor } from "./campaign-product-route-editor";
import type { MessageTriggerProductRouteModel } from "./message-trigger-editor-model";
import type { TranslateFn } from "../../types";
import { installResizeObserver } from "@/test-support/dom-test-utils";

const product: MessageTriggerProductRouteModel = {
  state: "ready",
  warning: "",
  accounts: [
    { id: "act_42", name: "Main account" },
    { id: "act_99", name: "Other account" },
  ],
  selectedAccountId: "act_42",
  labels: [{ id: "product-a", name: "Alpha", stale: false }],
  selectedLabelIds: ["product-a"],
  nameFallbacks: ["Alpha"],
};
const t: TranslateFn = (key, values) =>
  values ? `${key}:${values.name}` : key;

function ControlledEditor() {
  const [value, setValue] = useState(product);
  return (
    <CampaignProductRouteEditor
      product={value}
      t={t}
      onChange={patch =>
        setValue(current => ({
          ...current,
          selectedAccountId: patch.metaCampaignAdAccountId ?? "",
          selectedLabelIds:
            patch.metaCampaignLabels?.map(label => label.id) ?? [],
          nameFallbacks:
            patch.metaCampaignNameFallbacks ?? current.nameFallbacks,
        }))
      }
    />
  );
}

describe("campaign route account controls", () => {
  beforeAll(() => {
    installResizeObserver();
    Object.assign(window.HTMLElement.prototype, {
      hasPointerCapture: jest.fn(() => false),
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
      scrollIntoView: jest.fn(),
    });
  });

  it("keeps the account and name fallback when the last label is removed", () => {
    render(<ControlledEditor />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "triggerProductRouteRemoveLabel:Alpha",
      })
    );
    expect(
      screen.queryByRole("button", {
        name: "triggerProductRouteRemoveLabel:Alpha",
      })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "triggerProductRouteAccount" })
    ).toHaveTextContent("Main account");
    expect(
      screen.getByRole("combobox", { name: "triggerProductRouteAddLabels" })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "triggerProductRouteNameFallbackRemove:Alpha",
      })
    ).toBeInTheDocument();
  });

  it("keeps account scope when the last checked label is deselected in the picker", () => {
    const onChange = jest.fn();
    render(
      <CampaignProductRouteEditor product={product} t={t} onChange={onChange} />
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "triggerProductRouteAddLabels" })
    );
    fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
    expect(onChange).toHaveBeenCalledWith({
      metaCampaignAdAccountId: "act_42",
      metaCampaignLabels: undefined,
    });
  });

  it("associates each account label with its own control across editor instances", () => {
    const { container, rerender } = render(
      <>
        <CampaignProductRouteEditor
          product={product}
          t={t}
          onChange={jest.fn()}
        />
        <CampaignProductRouteEditor
          product={product}
          t={t}
          onChange={jest.fn()}
        />
      </>
    );
    const controls = screen.getAllByRole("combobox", {
      name: "triggerProductRouteAccount",
    });
    const labels = Array.from(container.querySelectorAll("label")).filter(
      label => label.textContent === "triggerProductRouteAccount"
    );
    expect(controls).toHaveLength(2);
    expect(controls[0]?.id).toBeTruthy();
    expect(controls[1]?.id).toBeTruthy();
    expect(controls[0]?.id).not.toBe(controls[1]?.id);
    expect(labels.map(label => label.control)).toEqual(controls);
    const ids = controls.map(control => control.id);
    rerender(
      <>
        <CampaignProductRouteEditor
          product={{ ...product }}
          t={t}
          onChange={jest.fn()}
        />
        <CampaignProductRouteEditor
          product={{ ...product }}
          t={t}
          onChange={jest.fn()}
        />
      </>
    );
    expect(
      screen
        .getAllByRole("combobox", { name: "triggerProductRouteAccount" })
        .map(control => control.id)
    ).toEqual(ids);
  });
});
