/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InternalLabelsManager } from "./internal-labels-manager";

jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
const fetchMock = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  fetchMock.mockReset();
  global.fetch = fetchMock;
});

it("locks a pending tag save so new edits cannot be silently lost", async () => {
  let resolveSave: (value: unknown) => void = () => undefined;
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ labels: [] }) })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveSave = resolve;
        })
    );
  render(<InternalLabelsManager workspaceId="workspace" />);
  await waitFor(() =>
    expect(screen.getByText("noLabelsYet")).toBeInTheDocument()
  );
  fireEvent.click(screen.getByRole("button", { name: "newLabel" }));
  fireEvent.change(screen.getByLabelText("name"), {
    target: { value: "Qualified" },
  });
  fireEvent.click(screen.getByRole("button", { name: "saveLabel" }));
  await waitFor(() => expect(screen.getByLabelText("name")).toBeDisabled());
  expect(screen.getByLabelText("descriptionColumn")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "newLabel", hidden: true })
  ).toBeDisabled();
  resolveSave({ ok: false, json: async () => ({ error: "failed" }) });
  await waitFor(() => expect(screen.getByLabelText("name")).toBeEnabled());
  expect(screen.getByLabelText("name")).toHaveValue("Qualified");
});
it("distinguishes a failed list request from no tags and retries", async () => {
  fetchMock
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "unavailable" }),
    })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ labels: [] }) });
  render(<InternalLabelsManager workspaceId="workspace" />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("loadTagsFailed")
  );
  expect(screen.queryByText("noLabelsYet")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "newLabel" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await waitFor(() =>
    expect(screen.getByText("noLabelsYet")).toBeInTheDocument()
  );
});
it("shows save failures in the dialog while keeping the entered tag", async () => {
  fetchMock
    .mockResolvedValueOnce({ ok: true, json: async () => ({ labels: [] }) })
    .mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "failed" }),
    });
  render(<InternalLabelsManager workspaceId="workspace" />);
  await waitFor(() =>
    expect(screen.getByText("noLabelsYet")).toBeInTheDocument()
  );
  fireEvent.click(screen.getByRole("button", { name: "newLabel" }));
  fireEvent.change(screen.getByLabelText("name"), {
    target: { value: "Qualified" },
  });
  fireEvent.click(screen.getByRole("button", { name: "saveLabel" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("saveFailed")
  );
  expect(screen.getByLabelText("name")).toHaveValue("Qualified");
});
