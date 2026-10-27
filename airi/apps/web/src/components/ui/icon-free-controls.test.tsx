/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({ scrollUp: "Scroll up", scrollDown: "Scroll down" })[
      key as "scrollUp" | "scrollDown"
    ] ?? key,
}));

function Choice({ iconFree = false, onValueChange = jest.fn() }) {
  return (
    <Select
      iconFree={iconFree}
      defaultValue="alpha"
      onValueChange={onValueChange}
    >
      <SelectTrigger aria-label="Channel">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="alpha">Alpha</SelectItem>
        <SelectItem value="beta">Beta</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("scoped icon-free controls", () => {
  afterEach(() => jest.restoreAllMocks());
  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent,
    });
    HTMLElement.prototype.scrollIntoView = jest.fn();
    HTMLElement.prototype.hasPointerCapture = jest.fn(() => false);
    HTMLElement.prototype.setPointerCapture = jest.fn();
    HTMLElement.prototype.releasePointerCapture = jest.fn();
  });

  it("keeps existing select and checkbox icons by default", () => {
    const { container } = render(
      <>
        <Choice />
        <Checkbox defaultChecked aria-label="Selected" />
      </>
    );
    expect(container.querySelectorAll("svg").length).toBe(2);
  });

  it("removes select indicators only when opted in and retains keyboard selection and focus", async () => {
    const user = userEvent.setup();
    const onValueChange = jest.fn();
    const { container } = render(
      <Choice iconFree onValueChange={onValueChange} />
    );
    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(container.querySelector("svg")).toBeNull();
    await user.tab();
    await user.keyboard("{Enter}");
    const selected = screen.getByRole("option", { name: "Alpha" });
    expect(selected.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector('[data-slot="select-content"] svg')
    ).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("beta");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toBe("Beta");
  });

  it("keeps checked and indeterminate semantics without SVG and toggles with Space", async () => {
    const user = userEvent.setup();
    const onCheckedChange = jest.fn();
    const { container } = render(
      <Checkbox
        iconFree
        defaultChecked="indeterminate"
        aria-label="Channels"
        onCheckedChange={onCheckedChange}
      />
    );
    const checkbox = screen.getByRole("checkbox", { name: "Channels" });
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    expect(container.querySelector("svg")).toBeNull();
    await user.tab();
    await user.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    await user.keyboard(" ");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
  });

  it("retains pointer scrolling through visible text controls in an overflowing menu", async () => {
    jest
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(80);
    jest
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(320);
    jest
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(30);
    const user = userEvent.setup();
    render(<Choice iconFree />);
    await user.click(screen.getByRole("combobox", { name: "Channel" }));
    const down = await screen.findByText("Scroll down");
    const viewport = document.querySelector(
      "[data-radix-select-viewport]"
    ) as HTMLElement;
    const before = viewport.scrollTop;
    fireEvent.pointerMove(down);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(before));
    fireEvent.pointerLeave(down);
    fireEvent.scroll(viewport);
    expect(await screen.findByText("Scroll up")).not.toBeNull();
    expect(
      document.querySelector('[data-slot="select-content"] svg')
    ).toBeNull();
  });
});
