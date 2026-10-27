/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LTVConfigForm, createLtvConfigSchema } from "./ltv-config-form";
import { toast } from "sonner";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const fetchMock = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
});

it.each(["100usd", "Infinity", "NaN", "0", "-1", " "])(
  "rejects malformed numeric input %s instead of partially parsing it",
  baseValue => {
    expect(
      createLtvConfigSchema(key => key).safeParse({
        baseValue,
        currency: "USD",
      }).success
    ).toBe(false);
  }
);

it("resets dirty state only after an acknowledged save", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true }),
  });
  render(
    <LTVConfigForm
      workspaceId="workspace"
      initialValues={{ baseValue: 100, currency: "USD" }}
    />
  );
  const save = screen.getByRole("button", { name: "ltvSaveButton" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton"), {
    target: { value: "150" },
  });
  fireEvent.click(save);
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  expect(save).toBeDisabled();
});

it("retains the edit and reports failure for an unacknowledged response", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ error: "failed" }),
  });
  render(
    <LTVConfigForm
      workspaceId="workspace"
      initialValues={{ baseValue: 100, currency: "USD" }}
    />
  );
  fireEvent.change(screen.getByRole("spinbutton"), {
    target: { value: "150" },
  });
  fireEvent.click(screen.getByRole("button", { name: "ltvSaveButton" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("ltvUpdateFailed")
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "ltvSaveButton" })).toBeEnabled();
});
