/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorState } from "./async-states";

it("keeps retry named, keyboard operable and separate from a surrounding form submission", async () => {
  const user = userEvent.setup();
  const onRetry = jest.fn();
  const onSubmit = jest.fn(event => event.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <ErrorState
        message="The report could not be loaded."
        onRetry={onRetry}
        retryLabel="Reload report"
      />
    </form>
  );
  const retry = screen.getByRole("button", { name: "Reload report" });

  expect(screen.getByRole("alert")).toHaveTextContent(
    "The report could not be loaded."
  );
  expect(retry.tagName).toBe("BUTTON");
  expect(retry).toHaveAttribute("type", "button");
  expect(retry).toHaveAttribute("data-slot", "button");
  expect(retry).toHaveClass(
    "focus-visible:ring-[3px]",
    "focus-visible:ring-ring/50"
  );
  expect(retry.querySelector("svg")).toBeNull();

  await user.tab();
  expect(retry).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});
