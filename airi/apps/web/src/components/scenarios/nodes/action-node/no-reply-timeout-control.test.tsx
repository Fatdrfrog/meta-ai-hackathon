/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { useState } from "react";
import { NoReplyTimeoutControl } from "./no-reply-timeout-control";

function Timer({ initial = 30 }: { initial?: number }) {
  const [minutes, setMinutes] = useState(initial);
  return (
    <>
      <NoReplyTimeoutControl
        minutes={minutes}
        onCommit={setMinutes}
        t={key => key}
      />
      <output aria-label="Saved minutes">{minutes}</output>
    </>
  );
}

test("keeps the edited amount when moving from minutes to days", async () => {
  const user = userEvent.setup();
  render(<Timer />);
  const amount = screen.getByRole("spinbutton", {
    name: "noReplyTimeoutAmount",
  });
  const unit = screen.getByRole("combobox", { name: "noReplyTimeoutUnit" });
  await user.clear(amount);
  await user.type(amount, "60");
  await user.selectOptions(unit, "days");
  expect(
    screen.getByRole("spinbutton", { name: "noReplyTimeoutAmount" })
  ).toHaveValue(60);
  expect(unit).toHaveValue("days");
  expect(screen.getByLabelText("Saved minutes")).toHaveTextContent("86400");
});

test("keeps the selected unit while a legacy edit awaits its parent update", async () => {
  const user = userEvent.setup();
  const onCommit = jest.fn();
  const props = { onCommit, t: (key: string) => key };
  const { rerender } = render(
    <NoReplyTimeoutControl {...props} minutes={30} />
  );
  await user.selectOptions(screen.getByRole("combobox"), "days");
  expect(onCommit).toHaveBeenLastCalledWith(43200);
  expect(screen.getByRole("combobox")).toHaveValue("days");
  const amount = screen.getByRole("spinbutton");
  await user.clear(amount);
  await user.type(amount, "2");
  await user.tab();
  expect(onCommit).toHaveBeenLastCalledWith(2880);
  expect(amount).toHaveValue(2);
  rerender(<NoReplyTimeoutControl {...props} minutes={2880} />);
  expect(screen.getByRole("combobox")).toHaveValue("days");
  expect(screen.getByRole("spinbutton")).toHaveValue(2);
});

test("switches to an exact unit for an external value and discards the previous unit's draft", async () => {
  const onCommit = jest.fn();
  const props = { onCommit, t: (key: string) => key };
  const { rerender } = render(
    <NoReplyTimeoutControl {...props} minutes={2880} />
  );
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "9" } });
  rerender(<NoReplyTimeoutControl {...props} minutes={120} />);
  expect(screen.getByRole("spinbutton")).toHaveValue(2);
  expect(screen.getByRole("combobox")).toHaveValue("hours");
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "24" } });
  fireEvent.blur(screen.getByRole("spinbutton"));
  expect(onCommit).toHaveBeenLastCalledWith(1440);
  rerender(<NoReplyTimeoutControl {...props} minutes={1440} />);
  expect(screen.getByRole("combobox")).toHaveValue("hours");
  expect(screen.getByRole("spinbutton")).toHaveValue(24);
});

test("shows an external value in its exact unit instead of the mounted unit", () => {
  const onCommit = jest.fn();
  const props = { onCommit, t: (key: string) => key };
  const { rerender } = render(
    <NoReplyTimeoutControl {...props} minutes={30} />
  );
  expect(screen.getByRole("combobox")).toHaveValue("minutes");
  rerender(<NoReplyTimeoutControl {...props} minutes={1440} />);
  expect(screen.getByRole("spinbutton")).toHaveValue(1);
  expect(screen.getByRole("combobox")).toHaveValue("days");
  expect(onCommit).not.toHaveBeenCalled();
});

test("drops the chosen unit when the parent restores an earlier value", async () => {
  const user = userEvent.setup();
  const onCommit = jest.fn();
  const props = { onCommit, t: (key: string) => key };
  const { rerender } = render(
    <NoReplyTimeoutControl {...props} minutes={1440} />
  );
  await user.selectOptions(screen.getByRole("combobox"), "minutes");
  expect(onCommit).toHaveBeenLastCalledWith(1);
  rerender(<NoReplyTimeoutControl {...props} minutes={1} />);
  const amount = screen.getByRole("spinbutton");
  await user.clear(amount);
  await user.type(amount, "45");
  await user.tab();
  expect(onCommit).toHaveBeenLastCalledWith(45);
  rerender(<NoReplyTimeoutControl {...props} minutes={45} />);
  expect(screen.getByRole("combobox")).toHaveValue("minutes");
  rerender(<NoReplyTimeoutControl {...props} minutes={1440} />);
  expect(screen.getByRole("spinbutton")).toHaveValue(1);
  expect(screen.getByRole("combobox")).toHaveValue("days");
  expect(onCommit).toHaveBeenCalledTimes(2);
});

test.each([30, 1440])(
  "does not commit %i minutes on blur or Enter without an edit",
  async minutes => {
    const user = userEvent.setup();
    const onCommit = jest.fn();
    render(
      <NoReplyTimeoutControl
        minutes={minutes}
        onCommit={onCommit}
        t={key => key}
      />
    );
    await user.click(screen.getByRole("spinbutton"));
    await user.keyboard("{Enter}");
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  }
);

test("commits a return to the saved value while an earlier commit is pending", async () => {
  const user = userEvent.setup();
  const onCommit = jest.fn();
  render(
    <NoReplyTimeoutControl minutes={30} onCommit={onCommit} t={key => key} />
  );
  await user.selectOptions(screen.getByRole("combobox"), "days");
  expect(onCommit).toHaveBeenLastCalledWith(43200);
  await user.selectOptions(screen.getByRole("combobox"), "minutes");
  expect(onCommit).toHaveBeenLastCalledWith(30);
  expect(onCommit).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("spinbutton")).toHaveValue(30);
});

test("commits a value re-entered after the parent rejected it", async () => {
  const user = userEvent.setup();
  const onCommit = jest.fn();
  render(
    <NoReplyTimeoutControl minutes={30} onCommit={onCommit} t={key => key} />
  );
  const amount = screen.getByRole("spinbutton");
  await user.clear(amount);
  await user.type(amount, "45{Enter}");
  await user.clear(amount);
  await user.type(amount, "45{Enter}");
  expect(onCommit.mock.calls).toEqual([[45], [45]]);
});

test("commits once when Enter is followed by blur before the parent applies it", async () => {
  const user = userEvent.setup();
  const onCommit = jest.fn();
  render(
    <NoReplyTimeoutControl minutes={30} onCommit={onCommit} t={key => key} />
  );
  const amount = screen.getByRole("spinbutton");
  await user.clear(amount);
  await user.type(amount, "45{Enter}");
  await user.tab();
  expect(onCommit.mock.calls).toEqual([[45]]);
});

test.each([
  ["minutes", 30, 525600],
  ["hours", 60, 8760],
  ["days", 1440, 365],
])(
  "clamps the %s amount without changing its unit",
  async (unit, initial, max) => {
    const user = userEvent.setup();
    render(<Timer initial={initial} />);
    const amount = screen.getByRole("spinbutton");
    await user.clear(amount);
    await user.type(amount, "999999");
    await user.tab();
    expect(amount).toHaveValue(max);
    expect(screen.getByRole("combobox")).toHaveValue(unit);
    expect(screen.getByLabelText("Saved minutes")).toHaveTextContent("525600");
  }
);

test("disables both controls for a read-only timer", async () => {
  const onCommit = jest.fn();
  render(
    <NoReplyTimeoutControl
      minutes={1440}
      disabled
      onCommit={onCommit}
      t={key => key}
    />
  );
  expect(screen.getByRole("spinbutton")).toBeDisabled();
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(onCommit).not.toHaveBeenCalled();
});

test("does not switch units when editing an exact hour or day", async () => {
  const user = userEvent.setup();
  render(<Timer initial={60} />);
  const amount = screen.getByRole("spinbutton", {
    name: "noReplyTimeoutAmount",
  });
  await user.clear(amount);
  await user.type(amount, "24");
  await user.tab();
  expect(amount).toHaveValue(24);
  expect(
    screen.getByRole("combobox", { name: "noReplyTimeoutUnit" })
  ).toHaveValue("hours");
  expect(screen.getByLabelText("Saved minutes")).toHaveTextContent("1440");
});

test("edits days repeatedly and restores an empty input without changing the timer", async () => {
  const user = userEvent.setup();
  render(<Timer initial={1440} />);
  const amount = screen.getByRole("spinbutton", {
    name: "noReplyTimeoutAmount",
  });
  await user.clear(amount);
  await user.type(amount, "2");
  await user.tab();
  expect(amount).toHaveValue(2);
  expect(screen.getByLabelText("Saved minutes")).toHaveTextContent("2880");
  await user.clear(amount);
  await user.type(amount, "12");
  await user.keyboard("{Enter}");
  await user.tab();
  expect(amount).toHaveValue(12);
  expect(screen.getByLabelText("Saved minutes")).toHaveTextContent("17280");
  await user.clear(amount);
  await user.tab();
  expect(amount).toHaveValue(12);
  expect(screen.getByLabelText("Saved minutes")).toHaveTextContent("17280");
});

test("chooses the unit from the shared native select", () => {
  render(<Timer initial={120} />);
  const unit = screen.getByRole("combobox", { name: "noReplyTimeoutUnit" });
  expect(unit.getAttribute("data-slot")).toBe("native-select");
  expect(
    Array.from(unit.querySelectorAll("option")).map(option => option.value)
  ).toEqual(["minutes", "hours", "days"]);
});
