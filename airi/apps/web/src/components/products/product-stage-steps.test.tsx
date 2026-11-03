/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { StageSteps, stepStates } from "./product-stage-steps";

// The five steps from a video to products on the shelf, each naming who
// does it.

const steps = () =>
  within(
    screen.getByRole("list", {
      name: "How Airi turns your video into products",
    })
  ).getAllByRole("listitem");

test("names the model at each step, and marks the current one", () => {
  render(<StageSteps current="photos" counts={{ photos: "3 of 7" }} />);

  const items = steps();
  expect(items.map(item => item.getAttribute("data-state"))).toEqual([
    "done",
    "done",
    "done",
    "current",
    "upcoming",
  ]);
  expect(items[0]).toHaveTextContent("PrepareAiri");
  expect(items[1]).toHaveTextContent("ListenElevenLabs Scribe v2", {
    normalizeWhitespace: true,
  });
  expect(items[2]).toHaveTextContent("WatchMuse Spark 1.3", {
    normalizeWhitespace: true,
  });
  expect(items[4]).toHaveTextContent("CheckYou");
  // The current step: its count beside its name, once.
  expect(items[3]).toHaveAttribute("aria-current", "step");
  expect(within(items[3]!).getByText("3 of 7")).toBeInTheDocument();
  expect(screen.getAllByText("3 of 7")).toHaveLength(1);
  expect(items[3]).toHaveTextContent("Muse Spark, SAM 3.1 and Muse Image 1.0", {
    normalizeWhitespace: true,
  });
  // Done steps say so to screen readers; the dots are decoration.
  expect(within(items[0]!).getByText("Done")).toHaveClass("sr-only");
  for (const item of items)
    expect(item.querySelector("[aria-hidden]")).not.toBeNull();
});

test("a step behind says what it came to, under its credit", () => {
  render(
    <StageSteps
      current="check"
      results={{ watch: "7 products found", photos: "7 of 7" }}
    />
  );

  const items = steps();
  expect(within(items[2]!).getByText("7 products found")).toBeInTheDocument();
  expect(within(items[3]!).getByText("7 of 7")).toBeInTheDocument();
  expect(items[4]).toHaveAttribute("aria-current", "step");
});

test("a stop is marked apart from the current step", () => {
  render(<StageSteps current="check" stopped="photos" />);

  const items = steps();
  expect(items[3]).toHaveAttribute("data-state", "stopped");
  expect(within(items[3]!).getByText("Stopped here")).toHaveClass("sr-only");
  expect(items[4]).toHaveAttribute("data-state", "current");
  // The phone's segments say the same, with the stop dashed apart.
  const segments = document.querySelectorAll(
    "[aria-hidden] > span[data-state]"
  );
  expect(
    [...segments].map(segment => segment.getAttribute("data-state"))
  ).toEqual(["done", "done", "done", "stopped", "current"]);
});

test("each step's state follows the current step and the stop", () => {
  expect(stepStates("prepare", null)).toEqual([
    "current",
    "upcoming",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);
  // Stopped where it is: the stop is all it shows there.
  expect(stepStates("listen", "listen")).toEqual([
    "done",
    "stopped",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);
});
