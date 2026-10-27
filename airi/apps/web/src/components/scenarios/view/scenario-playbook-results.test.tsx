/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ScenarioPlaybookResults } from "./scenario-playbook-results";

const report = {
  scenarioId: "scenario-1",
  period: { startDate: "2026-08-12", endDate: "2026-09-11" },
  totals: { sales: 2, bookings: 1, signups: 0, refunds: 1 },
  currencies: [
    {
      currency: "KZT",
      sales: 1,
      refunds: 1,
      grossRevenue: 10000,
      refundedRevenue: 2000,
      netRevenue: 8000,
    },
    {
      currency: "USD",
      sales: 1,
      refunds: 0,
      grossRevenue: 25,
      refundedRevenue: 0,
      netRevenue: 25,
    },
  ],
  truncated: false,
};

describe("ScenarioPlaybookResults", () => {
  const mockFetch = jest.fn();
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch;
  });

  function open() {
    fireEvent.click(screen.getByRole("button", { name: /title/ }));
  }
  function success(data = report) {
    return { ok: true, json: async () => data };
  }

  it("loads on demand and separates recorded money by currency", async () => {
    mockFetch.mockResolvedValue(success());
    render(
      <ScenarioPlaybookResults
        workspaceId="workspace-1"
        scenarioId="scenario-1"
      />
    );
    expect(mockFetch).not.toHaveBeenCalled();
    open();
    await screen.findByText("KZT");
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("8,000.00")).toBeInTheDocument();
    expect(screen.queryByText("8,025.00")).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("report=scenario&scenarioId=scenario-1&days=30"),
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("shows failures and allows a successful retry with an empty result", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    mockFetch.mockResolvedValueOnce(
      success({
        ...report,
        totals: { sales: 0, bookings: 0, signups: 0, refunds: 0 },
        currencies: [],
      })
    );
    render(
      <ScenarioPlaybookResults
        workspaceId="workspace-1"
        scenarioId="scenario-1"
      />
    );
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("error");
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("empty");
  });

  it("never shows a previous scenario's late response after workspace/selection changes", async () => {
    let resolveFirst!: (value: unknown) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    );
    mockFetch.mockResolvedValueOnce(
      success({ ...report, scenarioId: "scenario-2", currencies: [] })
    );
    const view = render(
      <ScenarioPlaybookResults
        workspaceId="workspace-1"
        scenarioId="scenario-1"
      />
    );
    open();
    view.rerender(
      <ScenarioPlaybookResults
        workspaceId="workspace-2"
        scenarioId="scenario-2"
      />
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await act(async () => resolveFirst(success()));
    expect(screen.queryByText("KZT")).not.toBeInTheDocument();
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
