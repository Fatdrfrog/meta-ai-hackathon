/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ScenarioIntegerInput } from "./integer-input";

test.each([
  ["2e3", 2000],
  ["2e-1", 1],
  ["3.9", 3],
  ["99999", 5000],
  ["", 12],
])("commits the complete numeric value %s within bounds", (draft, expected) => {
  const onValueCommit = jest.fn();
  render(
    <ScenarioIntegerInput
      aria-label="Amount"
      value={12}
      defaultValue={30}
      min={1}
      max={5000}
      onValueCommit={onValueCommit}
    />
  );
  const input = screen.getByRole("spinbutton", { name: "Amount" });
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.blur(input);
  expect(onValueCommit).toHaveBeenLastCalledWith(expected);
  expect(input).toHaveValue(expected);
});

test("commits an edit once when Enter is followed by blur", () => {
  const onValueCommit = jest.fn();
  render(
    <ScenarioIntegerInput
      aria-label="Amount"
      value={12}
      defaultValue={30}
      min={1}
      onValueCommit={onValueCommit}
    />
  );
  const input = screen.getByRole("spinbutton", { name: "Amount" });
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  expect(onValueCommit.mock.calls).toEqual([[45]]);
  fireEvent.change(input, { target: { value: "46" } });
  fireEvent.blur(input);
  expect(onValueCommit.mock.calls).toEqual([[45], [46]]);
});
