jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

import { toast } from "sonner";
import { showScenarioErrorToast } from "./action-node-utils";

const toastError = toast.error as jest.Mock;

describe("showScenarioErrorToast", () => {
  beforeEach(() => toastError.mockClear());

  it("shows only the localized fallback without showReason", () => {
    showScenarioErrorToast(
      "Couldn't save the text. Try again.",
      new Error("E11000 duplicate key error collection: recipients")
    );

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't save the text. Try again."
    );
  });

  it("adds the server reason as the description with showReason", () => {
    showScenarioErrorToast(
      "Couldn't submit the template. Try again.",
      new Error("  Template name already exists in this language.  "),
      { showReason: true }
    );

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't submit the template. Try again.",
      { description: "Template name already exists in this language." }
    );
  });

  it.each([
    ["no error", undefined],
    ["a non-Error value", "boom"],
    ["an empty message", new Error("   ")],
    ["the fallback itself", new Error("Couldn't load texts. Try again.")],
  ])("adds no description for %s", (_name, error) => {
    showScenarioErrorToast("Couldn't load texts. Try again.", error, {
      showReason: true,
    });

    expect(toastError).toHaveBeenCalledWith("Couldn't load texts. Try again.");
  });
});
