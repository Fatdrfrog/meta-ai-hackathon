/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react";

import { useTransitionOwnerKey } from "./use-transition-owner-key";

describe("useTransitionOwnerKey", () => {
  it("keeps the owner stable within a visit and changes it across A to B to A", () => {
    const { result, rerender } = renderHook(
      ({ valueKey }) => useTransitionOwnerKey(valueKey),
      { initialProps: { valueKey: "workspace-a" } }
    );
    const firstWorkspaceAOwner = result.current;

    rerender({ valueKey: "workspace-a" });
    expect(result.current).toBe(firstWorkspaceAOwner);

    rerender({ valueKey: "workspace-b" });
    const workspaceBOwner = result.current;
    expect(workspaceBOwner).not.toBe(firstWorkspaceAOwner);

    rerender({ valueKey: "workspace-a" });
    expect(result.current).not.toBe(firstWorkspaceAOwner);
    expect(result.current).not.toBe(workspaceBOwner);
  });

  it("does not re-render the caller when the value key changes", () => {
    let renderCount = 0;
    const { rerender } = renderHook(
      ({ valueKey }) => {
        renderCount += 1;
        return useTransitionOwnerKey(valueKey);
      },
      { initialProps: { valueKey: "workspace-a" } }
    );
    expect(renderCount).toBe(1);

    // A render-phase state update forces a second render for this change.
    // The ref-based owner must not, so the count stays at one per rerender.
    rerender({ valueKey: "workspace-b" });
    expect(renderCount).toBe(2);
  });
});
