/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ScenarioTriggerConfig } from "../../types";
import { BusinessEventTriggerEditor } from "./business-event-trigger-editor";
import {
  EMPTY_BUSINESS_EVENT_CATALOG,
  type BusinessEventTriggerCatalog,
} from "./business-event-trigger-model";
import { installResizeObserver } from "@/test-support/dom-test-utils";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join(",")})` : key,
}));

type Config = NonNullable<ScenarioTriggerConfig["businessEvent"]>;
const catalog: BusinessEventTriggerCatalog = {
  status: "ready",
  integrations: [
    {
      id: "store",
      name: "Example Store",
      events: [
        {
          id: "status-changed",
          name: "Order status changed",
          fields: [
            {
              key: "status",
              label: "Order status",
              type: "enum",
              options: [
                { value: "shipped", label: "Shipped" },
                { value: "delivered", label: "Delivered" },
              ],
            },
            { key: "total", label: "Order total", type: "number" },
            { key: "paid", label: "Paid", type: "boolean" },
            { key: "reference", label: "Reference", type: "text" },
          ],
        },
        { id: "created", name: "Order created", fields: [] },
      ],
    },
    { id: "erp", name: "Example ERP", events: [] },
  ],
};
const saved: Config = {
  integrationId: "store",
  integrationName: "Example Store",
  eventId: "status-changed",
  eventName: "Order status changed",
};

function Harness({
  initial = {},
  onChange,
}: {
  initial?: Config;
  onChange: jest.Mock;
}) {
  const [value, setValue] = useState(initial);
  return (
    <BusinessEventTriggerEditor
      value={value}
      catalog={catalog}
      onChange={next => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe("business event trigger editor", () => {
  it("opens integration setup without unloading unsaved scenario changes", () => {
    render(
      <BusinessEventTriggerEditor
        onChange={jest.fn()}
        integrationsHref="/integrations"
      />
    );
    const link = screen.getByRole("link", {
      name: "businessEventOpenIntegrations",
    });
    expect(link).toHaveAttribute("href", "/integrations");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
  beforeAll(() => {
    Object.assign(window.HTMLElement.prototype, {
      scrollIntoView: jest.fn(),
      hasPointerCapture: jest.fn(() => false),
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
    });
    installResizeObserver();
  });

  it("shows an honest draft-only empty state without offering invented integrations", () => {
    const onChange = jest.fn();
    render(
      <BusinessEventTriggerEditor
        catalog={EMPTY_BUSINESS_EVENT_CATALOG}
        onChange={onChange}
        integrationsHref="/integrations"
      />
    );
    expect(screen.getByText("businessEventDraftDescription")).toBeVisible();
    expect(screen.getByText("businessEventNoIntegrations")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "businessEventOpenIntegrations" })
    ).toHaveAttribute("href", "/integrations");
    expect(
      screen.getByRole("combobox", { name: "businessEventIntegration" })
    ).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves saved configuration across loading, errors, retries and missing catalog metadata", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const onRetry = jest.fn();
    const config: Config = {
      ...saved,
      filters: [{ field: "status", operator: "equals", value: "shipped" }],
    };
    const view = render(
      <BusinessEventTriggerEditor
        value={config}
        catalog={{ status: "loading", integrations: [] }}
        onChange={onChange}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText("businessEventLoading")).toBeVisible();
    expect(screen.getByText("Example Store")).toBeVisible();
    view.rerender(
      <BusinessEventTriggerEditor
        value={config}
        catalog={{ status: "error", integrations: [] }}
        onChange={onChange}
        onRetry={onRetry}
      />
    );
    await user.click(
      screen.getByRole("button", { name: "businessEventRetry" })
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    view.rerender(
      <BusinessEventTriggerEditor
        value={config}
        catalog={EMPTY_BUSINESS_EVENT_CATALOG}
        onChange={onChange}
      />
    );
    expect(screen.getByText("Example Store")).toBeVisible();
    expect(screen.getByText("Order status changed")).toBeVisible();
    expect(screen.getByDisplayValue("shipped")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears dependent values only when the user chooses another integration", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <Harness
        initial={{
          ...saved,
          filters: [{ field: "status", operator: "equals", value: "shipped" }],
        }}
        onChange={onChange}
      />
    );
    const picker = screen.getByRole("combobox", {
      name: "businessEventIntegration",
    });
    picker.focus();
    await user.keyboard("{ArrowDown}");
    await user.type(
      screen.getByRole("combobox", {
        name: "businessEventSearch(businessEventIntegration)",
      }),
      "Example ERP"
    );
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith({
      integrationId: "erp",
      integrationName: "Example ERP",
      eventId: undefined,
      eventName: undefined,
      filters: [],
    });
    expect(screen.getByText("businessEventNoEvents")).toBeVisible();
    expect(picker).toHaveFocus();
  });

  it("clears filters on an explicit event change while preserving the integration", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <Harness
        initial={{
          ...saved,
          filters: [{ field: "status", operator: "equals", value: "shipped" }],
        }}
        onChange={onChange}
      />
    );
    await user.click(
      screen.getByRole("combobox", { name: "businessEventEvent" })
    );
    await user.click(screen.getByRole("option", { name: "Order created" }));
    expect(onChange).toHaveBeenCalledWith({
      ...saved,
      eventId: "created",
      eventName: "Order created",
      filters: [],
    });
  });

  it("adds a field condition without choosing a value automatically", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness initial={saved} onChange={onChange} />);
    await user.click(
      screen.getByRole("button", { name: "businessEventAddFilter" })
    );
    await user.click(screen.getByRole("option", { name: "Order status" }));
    expect(onChange).toHaveBeenCalledWith({
      ...saved,
      filters: [{ field: "status", operator: "equals", value: "" }],
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "businessEventFilterValue" })
      ).toHaveFocus()
    );
    await user.click(
      screen.getByRole("combobox", { name: "businessEventFilterValue" })
    );
    await user.click(screen.getByRole("option", { name: "Shipped" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...saved,
      filters: [{ field: "status", operator: "equals", value: "shipped" }],
    });
  });

  it("stores number and boolean conditions as scalar strings and supports not equals", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <Harness
        initial={{
          ...saved,
          filters: [
            { field: "total", operator: "equals", value: "12.5" },
            { field: "paid", operator: "equals", value: "false" },
          ],
        }}
        onChange={onChange}
      />
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "businessEventFilterValue" }),
      { target: { value: "45.75" } }
    );
    expect(onChange.mock.lastCall?.[0].filters[0].value).toBe("45.75");
    await user.click(
      screen.getByRole("combobox", { name: "businessEventFilterValue" })
    );
    await user.click(screen.getByRole("option", { name: "businessEventTrue" }));
    expect(onChange.mock.lastCall?.[0].filters[1].value).toBe("true");
    await user.click(
      screen.getAllByRole("combobox", {
        name: "businessEventFilterOperator",
      })[1]
    );
    await user.click(
      screen.getByRole("option", { name: "businessEventNotEquals" })
    );
    expect(onChange.mock.lastCall?.[0].filters[1].operator).toBe("not_equals");
  });

  it("preserves an unavailable saved enum option until explicitly removed", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <Harness
        initial={{
          ...saved,
          filters: [
            { field: "status", operator: "equals", value: "archived" },
            { field: "old_field", operator: "not_equals", value: "keep" },
          ],
        }}
        onChange={onChange}
      />
    );
    expect(
      screen.getByRole("combobox", { name: "businessEventFilterValue" })
    ).toHaveTextContent("archived");
    expect(screen.getByDisplayValue("keep")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "businessEventRemoveFilter(1)" })
    );
    expect(onChange).toHaveBeenCalledWith({
      ...saved,
      filters: [{ field: "old_field", operator: "not_equals", value: "keep" }],
    });
  });

  it("exposes event data separately without claiming active template variable mappings", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Harness initial={saved} onChange={onChange} />);
    await user.click(
      screen.getByRole("button", { name: /businessEventDataFields/ })
    );
    const data = screen.getByRole("region", {
      name: "businessEventDataFields",
    });
    expect(within(data).getByText("Order total")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("limits adding conditions without dropping existing ones", () => {
    const onChange = jest.fn();
    render(
      <Harness
        initial={{
          ...saved,
          filters: Array.from({ length: 20 }, (_, i) => ({
            field: "reference",
            operator: "not_equals",
            value: String(i),
          })),
        }}
        onChange={onChange}
      />
    );
    expect(
      screen.getByRole("button", { name: "businessEventAddFilter" })
    ).toBeDisabled();
    expect(screen.getByText("businessEventFilterLimit(20)")).toBeVisible();
    expect(
      screen.getAllByRole("textbox", { name: "businessEventFilterValue" })
    ).toHaveLength(20);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not clear conditions when reselecting the current integration or event", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <Harness
        initial={{
          ...saved,
          filters: [{ field: "status", operator: "equals", value: "shipped" }],
        }}
        onChange={onChange}
      />
    );
    await user.click(
      screen.getByRole("combobox", { name: "businessEventIntegration" })
    );
    await user.click(screen.getByRole("option", { name: "Example Store" }));
    await user.click(
      screen.getByRole("combobox", { name: "businessEventEvent" })
    );
    await user.click(
      screen.getByRole("option", { name: "Order status changed" })
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: "businessEventFilterValue" })
    ).toHaveTextContent("Shipped");
  });

  it("lets the user clear unavailable saved event selections without needing catalog access", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <BusinessEventTriggerEditor
        value={{
          ...saved,
          filters: [{ field: "status", operator: "equals", value: "shipped" }],
        }}
        catalog={EMPTY_BUSINESS_EVENT_CATALOG}
        onChange={onChange}
      />
    );
    await user.click(
      screen.getByRole("button", {
        name: "businessEventClearSelection(businessEventEvent)",
      })
    );
    expect(onChange).toHaveBeenCalledWith({
      ...saved,
      eventId: undefined,
      eventName: undefined,
      filters: [],
    });
  });

  it("moves focus to the next condition value and then Add condition after removals", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          ...saved,
          filters: [
            { field: "total", operator: "equals", value: "25" },
            { field: "reference", operator: "not_equals", value: "draft" },
          ],
        }}
        onChange={jest.fn()}
      />
    );
    await user.click(
      screen.getByRole("button", { name: "businessEventRemoveFilter(1)" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "businessEventFilterValue" })
      ).toHaveFocus()
    );
    await user.click(
      screen.getByRole("button", { name: "businessEventRemoveFilter(1)" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "businessEventAddFilter" })
      ).toHaveFocus()
    );
  });
});
