/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "@supabase/supabase-js";
import messages from "../../../../../../messages/settings/layout/en/page.json";
import { ProfileForm } from "./profile-form";
const mockUpdate = jest.fn();
const mockRefresh = jest.fn();
jest.mock("../actions", () => ({
  updateProfile: (...args: unknown[]) => mockUpdate(...args),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    (messages.Settings as Record<string, string>)[key] ?? key,
}));
const user = {
  id: "u1",
  email: "name@example.com",
  user_metadata: { full_name: "Name" },
} as unknown as User;
beforeEach(() => {
  jest.clearAllMocks();
  mockUpdate.mockResolvedValue({ success: true, error: null });
});

it("disables unchanged saves and shows the account email as read-only", () => {
  render(<ProfileForm user={user} />);
  expect(
    screen.getByRole("button", { name: messages.Settings.saveButton })
  ).toBeDisabled();
  expect(screen.getByLabelText(messages.Settings.emailLabel)).toHaveAttribute(
    "readonly"
  );
});

it("does not submit a whitespace-only name", async () => {
  render(<ProfileForm user={user} />);
  fireEvent.change(screen.getByLabelText(messages.Settings.fullNameLabel), {
    target: { value: "   " },
  });
  fireEvent.click(
    screen.getByRole("button", { name: messages.Settings.saveButton })
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      messages.Settings.fullNameRequired
    )
  );
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("rejects unsupported avatar files before submission", () => {
  render(<ProfileForm user={user} />);
  fireEvent.change(screen.getByLabelText(messages.Settings.avatarLabel), {
    target: {
      files: [new File(["image"], "avatar.svg", { type: "image/svg+xml" })],
    },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    messages.Settings.avatarTypeError
  );
  expect(
    screen.getByRole("button", { name: messages.Settings.saveButton })
  ).toBeDisabled();
});

it("saves a normalized name and clears the dirty state after success", async () => {
  render(<ProfileForm user={user} />);
  fireEvent.change(screen.getByLabelText(messages.Settings.fullNameLabel), {
    target: { value: " New Name " },
  });
  fireEvent.click(
    screen.getByRole("button", { name: messages.Settings.saveButton })
  );
  await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
  expect(mockUpdate.mock.calls[0][1].get("fullName")).toBe("New Name");
  expect(
    screen.getByRole("button", { name: messages.Settings.saveButton })
  ).toBeDisabled();
});
