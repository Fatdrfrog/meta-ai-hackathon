/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { AiriLanguageSelector } from "./airi-language-selector";
import { AiContextManager } from "./ai-context-manager";
jest.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "workspace-1" }),
  useRouter: () => ({ refresh: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
it("renders language settings read-only for ordinary members", () => {
  render(<AiriLanguageSelector initialLanguage="en" readOnly />);
  for (const radio of screen.getAllByRole("radio"))
    expect(radio).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "saveChanges" })
  ).not.toBeInTheDocument();
});
it("renders company context read-only for ordinary members", () => {
  render(<AiContextManager initialTags={["Sales"]} readOnly />);
  expect(screen.getByPlaceholderText("placeholder")).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "saveChanges" })
  ).not.toBeInTheDocument();
});
