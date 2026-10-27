/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useScenarioSimulation } from "./use-scenario-simulation";
import type { ScenarioDraftPreviewInput } from "./evaluation";
const run = jest.fn();
jest.mock("@/lib/scenarios/client/simulation", () => ({
  simulateScenarioStepRequest: (...args: unknown[]) => run(...args),
}));
const draft = {
  scenarioId: "one",
  name: "Example",
  status: "draft",
  priority: 1,
  nodes: [],
  edges: [],
} as ScenarioDraftPreviewInput;
const response = {
  state: { status: "waiting", actionNodeId: "first" },
  message: { bodyText: "Hello", actionNodeId: "first", dynamic: false },
  pathNodeIds: ["first"],
  pathEdgeIds: [],
};
beforeEach(() => run.mockReset());
it("retains the continuation state between customer events", async () => {
  run.mockResolvedValue(response);
  const { result } = renderHook(() =>
    useScenarioSimulation({ workspaceId: "workspace", draftScenario: draft })
  );
  await act(async () => {
    await result.current.run({ kind: "start" });
  });
  await act(async () => {
    await result.current.run({ kind: "message", text: "Hi" });
  });
  expect(run.mock.calls[1][0].state).toEqual(response.state);
  expect(result.current.entries.filter(e => e.kind === "customer")).toEqual([
    expect.objectContaining({ text: "Hi" }),
  ]);
});
it("ignores a late response after changing the draft and aborts its request", async () => {
  let resolve!: (value: unknown) => void;
  run.mockReturnValue(
    new Promise(done => {
      resolve = done;
    })
  );
  const { result, rerender } = renderHook(
    ({ value }) =>
      useScenarioSimulation({ workspaceId: "workspace", draftScenario: value }),
    { initialProps: { value: draft } }
  );
  act(() => {
    void result.current.run({ kind: "start" });
  });
  const signal = run.mock.calls[0][0].signal;
  rerender({ value: { ...draft, name: "Changed" } });
  await act(async () => {
    resolve(response);
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(signal.aborted).toBe(true);
  expect(result.current.entries).toEqual([]);
  expect(result.current.result).toBeNull();
});
it("can retry a failed evaluation without appending phantom chat messages", async () => {
  run
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValue(response);
  const { result } = renderHook(() =>
    useScenarioSimulation({ workspaceId: "workspace", draftScenario: draft })
  );
  await act(async () => {
    await result.current.run({ kind: "start" });
  });
  expect(result.current.error).toBe("Temporary failure");
  expect(result.current.entries).toEqual([]);
  await act(async () => {
    await result.current.run({ kind: "start" });
  });
  expect(result.current.error).toBeNull();
  expect(result.current.entries).toHaveLength(1);
});
