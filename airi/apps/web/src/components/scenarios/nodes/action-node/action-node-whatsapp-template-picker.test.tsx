/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useState, type ComponentProps } from "react";
import { ActionNodeWhatsAppTemplatePicker } from "./action-node-whatsapp-template-picker";
import {
  formatWhatsAppTemplateLanguage,
  resolveLanguageNamesLocales,
} from "./action-node-whatsapp-template-language";
import { installResizeObserver } from "@/test-support/dom-test-utils";

beforeAll(() => {
  installResizeObserver();
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  document.documentElement.lang = "en";
});

const OPTIONS = [
  { id: "t-1", name: "order_update", language: "en_US" },
  { id: "t-2", name: "welcome", language: "kk" },
];

type PickerProps = ComponentProps<typeof ActionNodeWhatsAppTemplatePicker>;

function Harness({ onOpenChange, ...overrides }: Partial<PickerProps>) {
  const [open, setOpen] = useState(false);
  return (
    <ActionNodeWhatsAppTemplatePicker
      id="node-1"
      options={OPTIONS}
      onSelect={jest.fn()}
      loading={false}
      listLoading={false}
      loadingLabel="loadingItems"
      {...overrides}
      open={open}
      onOpenChange={next => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    />
  );
}

function openPicker() {
  fireEvent.click(
    screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
  );
  return screen.getByRole("combobox", { name: "whatsappTemplateSearch" });
}

describe("ActionNodeWhatsAppTemplatePicker", () => {
  it("labels the field and shows the template with its language name", () => {
    render(<Harness value="order_update::en_US" />);
    const trigger = screen.getByRole("combobox", {
      name: "whatsappTemplateSelectLabel",
    });
    expect(trigger).toHaveTextContent("order_update");
    expect(trigger).toHaveTextContent("American English");
    expect(trigger).not.toHaveTextContent("[en_US]");
    expect(trigger.className).toContain("nokey");
  });

  it("falls back to the saved template while the list lacks it", () => {
    render(
      <Harness
        options={[]}
        value="gone::ru"
        savedName="gone"
        savedLanguage="ru"
      />
    );
    expect(
      screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
    ).toHaveTextContent("goneRussian");
  });

  it("shows a placeholder when no template is chosen", () => {
    render(<Harness />);
    expect(
      screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
    ).toHaveTextContent("whatsappTemplateSelectPlaceholder");
  });

  it("searches templates and reports a query without matches", () => {
    const onSelect = jest.fn();
    render(<Harness onSelect={onSelect} onCreateNew={jest.fn()} />);
    const search = openPicker();
    expect(screen.getByRole("option", { name: /order_update/ })).toBeVisible();
    expect(screen.queryByText("whatsappTemplateNoApproved")).toBeNull();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("whatsappTemplateNotFound")).toBeInTheDocument();
    // The create item stays reachable whatever the query.
    expect(
      screen.getByRole("option", { name: "whatsappTemplateCreateNew" })
    ).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "welc" } });
    fireEvent.click(screen.getByRole("option", { name: /welcome/ }));
    expect(onSelect).toHaveBeenCalledWith("welcome::kk");
  });

  it.each(["click", "Enter"])(
    "closes without selecting when the checked template is picked again (%s)",
    input => {
      const onSelect = jest.fn();
      const onOpenChange = jest.fn();
      render(
        <Harness
          value="order_update::en_US"
          onSelect={onSelect}
          onOpenChange={onOpenChange}
        />
      );
      const search = openPicker();
      if (input === "click") {
        fireEvent.click(screen.getByRole("option", { name: /order_update/ }));
      } else {
        // cmdk highlights the first item, which is the checked one here.
        fireEvent.keyDown(search, { key: "Enter" });
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
      expect(screen.queryByRole("option", { name: /order_update/ })).toBeNull();
    }
  );

  it("says there are no approved templates when the list is empty", () => {
    render(<Harness options={[]} />);
    const search = openPicker();
    expect(screen.getByText("whatsappTemplateNoApproved")).toBeInTheDocument();
    expect(screen.queryByText("whatsappTemplateNotFound")).toBeNull();
    fireEvent.change(search, { target: { value: "x" } });
    expect(screen.getByText("whatsappTemplateNotFound")).toBeInTheDocument();
    expect(screen.queryByText("whatsappTemplateNoApproved")).toBeNull();
  });

  it("shows skeleton rows while an empty list loads", () => {
    render(<Harness options={[]} listLoading />);
    openPicker();
    expect(
      screen.getByTestId("whatsapp-template-list-loading")
    ).toHaveTextContent("loadingItems");
    expect(screen.queryByText("whatsappTemplateNoApproved")).toBeNull();
  });

  it("opens the create drawer from the footer item and closes the list", () => {
    const onCreateNew = jest.fn();
    const onOpenChange = jest.fn();
    render(<Harness onCreateNew={onCreateNew} onOpenChange={onOpenChange} />);
    openPicker();
    fireEvent.click(
      screen.getByRole("option", { name: "whatsappTemplateCreateNew" })
    );
    expect(onCreateNew).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("omits the create item when templates cannot be created here", () => {
    render(<Harness />);
    openPicker();
    expect(
      screen.queryByRole("option", { name: "whatsappTemplateCreateNew" })
    ).toBeNull();
  });

  it("announces loading on the field without a visible text line", () => {
    render(<Harness loading />);
    const trigger = screen.getByRole("combobox", {
      name: "whatsappTemplateSelectLabel",
    });
    expect(trigger.querySelector(".animate-spin")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(trigger.querySelector(".sr-only")).toHaveTextContent("loadingItems");
  });

  it("keeps pointer presses away from the canvas", () => {
    const onParentPointerDown = jest.fn();
    render(
      <div onPointerDown={onParentPointerDown}>
        <Harness />
      </div>
    );
    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "whatsappTemplateSelectLabel" })
    );
    expect(onParentPointerDown).not.toHaveBeenCalled();
  });
});

describe("formatWhatsAppTemplateLanguage", () => {
  it("names WhatsApp language codes and keeps unknown ones", () => {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    expect(formatWhatsAppTemplateLanguage("kk", names)).toBe("Kazakh");
    expect(formatWhatsAppTemplateLanguage("pt_BR", names)).toBe(
      "Brazilian Portuguese"
    );
    expect(formatWhatsAppTemplateLanguage("not a code!", names)).toBe(
      "not a code!"
    );
    expect(formatWhatsAppTemplateLanguage("kk", null)).toBe("kk");
    expect(formatWhatsAppTemplateLanguage(undefined, names)).toBe("");
  });
});

describe("resolveLanguageNamesLocales", () => {
  it("names languages in the page language, reading kz as Kazakh", () => {
    expect(resolveLanguageNamesLocales("kz")).toEqual(["kk"]);
    expect(resolveLanguageNamesLocales("ru")).toEqual(["ru"]);
    expect(resolveLanguageNamesLocales("")).toBeUndefined();
  });
});
