/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaxonomyManager } from "./taxonomy-manager";
import { DEFAULT_TAXONOMY } from "@/lib/classifier/taxonomy";
import { toast } from "sonner";

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { number: number }) =>
    values ? `${key} ${values.number}` : key,
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }));
const fetchMock = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, id: "taxonomy" }),
  });
});
const initial = {
  labels: ["Sales", "Other"],
  guidelines: "",
  few_shots: [],
  confidence_threshold: 0,
};
function mount(overrides = {}) {
  render(
    <TaxonomyManager
      workspaceId="workspace"
      initialTaxonomy={{ ...initial, ...overrides }}
      defaultTemplate={DEFAULT_TAXONOMY}
    />
  );
}
function edit() {
  fireEvent.change(screen.getByLabelText("guidelines"), {
    target: { value: "Updated" },
  });
}

it("preserves empty instructions and a zero confidence, and accepts fewer than three topics", async () => {
  mount();
  expect(screen.getByLabelText("guidelines")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "confidenceThreshold" }));
  expect(screen.getByRole("spinbutton", { name: "confidenceThreshold" })).toHaveValue(0);
  edit();
  fireEvent.click(screen.getByRole("button", { name: "saveTaxonomy" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.confidence_threshold).toBe(0);
  expect(body.labels).toEqual(["Sales", "Other"]);
  expect(screen.getByRole("button", { name: "saveTaxonomy" })).toBeDisabled();
  edit();
  fireEvent.change(screen.getByLabelText("guidelines"), {
    target: { value: "Another edit" },
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it.each([
  { examples: [{ text: "Question", label: "" }] },
  { examples: [{ text: "Question", label: "Removed topic" }] },
])("does not silently discard incomplete or outdated examples", ({ examples }) => {
  mount({ few_shots: examples });
  edit();
  fireEvent.click(screen.getByRole("button", { name: "saveTaxonomy" }));
  expect(screen.getByRole("alert")).toHaveTextContent("validation.examples");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("does not report success for a failed or unacknowledged write", async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ error: "failed" }),
  });
  mount();
  edit();
  fireEvent.click(screen.getByRole("button", { name: "saveTaxonomy" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("saveFailed")
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it("does not replace an empty threshold with a default", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "confidenceThreshold" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "confidenceThreshold" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "saveTaxonomy" }));
  expect(screen.getByRole("alert")).toHaveTextContent("validation.confidence");
  expect(fetchMock).not.toHaveBeenCalled();
});
