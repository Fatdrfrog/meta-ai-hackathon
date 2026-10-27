/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { useSyncedDraftValue } from "./draft-state";

test("does not resurrect an old draft when external updates return to the original value", () => {
  const { result, rerender } = renderHook(
    ({ committed }) => useSyncedDraftValue(committed),
    { initialProps: { committed: 30 } }
  );
  act(() => result.current[1](60));
  expect(result.current[0]).toBe(60);
  rerender({ committed: 120 });
  expect(result.current[0]).toBe(120);
  rerender({ committed: 30 });
  expect(result.current[0]).toBe(30);
  act(() => result.current[1](value => value + 1));
  expect(result.current[0]).toBe(31);
});

test("preserves a local draft while syncing is suspended, then adopts the current value", () => {
  const { result, rerender } = renderHook(
    ({ committed, sync }) => useSyncedDraftValue(committed, sync),
    { initialProps: { committed: "saved", sync: true } }
  );
  act(() => result.current[1]("draft"));
  rerender({ committed: "external", sync: false });
  expect(result.current[0]).toBe("draft");
  rerender({ committed: "external", sync: true });
  expect(result.current[0]).toBe("external");
  rerender({ committed: "saved", sync: true });
  expect(result.current[0]).toBe("saved");
});
