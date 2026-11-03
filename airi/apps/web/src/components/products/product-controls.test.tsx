/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ProductCheck,
  ProductChip,
  ProductSegmented,
} from "./product-controls";

test("the check only shows the state, which the control around it carries", () => {
  render(
    <label>
      <input type="checkbox" checked readOnly />
      <ProductCheck checked />
      Carousel
    </label>
  );
  expect(screen.getByRole("checkbox", { name: "Carousel" })).toBeChecked();
  const check = document.querySelector("[aria-hidden='true']");
  expect(check).toHaveAttribute("data-checked", "true");
  expect(check).not.toHaveAttribute("data-disabled");
});

test("an unchecked, disabled check says so for its style", () => {
  const { container } = render(<ProductCheck checked={false} disabled />);
  const check = container.firstElementChild;
  expect(check).not.toHaveAttribute("data-checked");
  expect(check).toHaveAttribute("data-disabled", "true");
});

test("a chip carries its tone", () => {
  render(<ProductChip tone="ok">Order form ready</ProductChip>);
  expect(screen.getByText("Order form ready")).toHaveAttribute(
    "data-tone",
    "ok"
  );
});

test("the segmented toggle marks the chosen one and reports a new choice", () => {
  const onChange = jest.fn();
  render(
    <ProductSegmented
      label="Preview"
      options={[
        { value: "carousel", label: "Carousel" },
        { value: "form", label: "Order form" },
      ]}
      value="carousel"
      onChange={onChange}
    />
  );
  const group = screen.getByRole("group", { name: "Preview" });
  expect(group).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Carousel" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  fireEvent.click(screen.getByRole("button", { name: "Carousel" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Order form" }));
  expect(onChange).toHaveBeenCalledWith("form");
});
