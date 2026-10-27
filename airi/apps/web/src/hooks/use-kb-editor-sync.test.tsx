/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { atom, useAtomValue } from "jotai";
import { useKBEditorSync } from "./use-kb-editor-sync";
import type { SaveStatus } from "@/components/kb/save-status-badge";

jest.mock("sonner", () => ({
  toast: {
    message: jest.fn(),
  },
}));

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createEditorSyncAtoms() {
  return {
    isPublishingAtom: atom(false),
    saveStatusAtom: atom<SaveStatus>("saved"),
    publishHandlerAtom: atom<(() => Promise<void>) | null>(null),
  };
}

describe("useKBEditorSync", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("runs a save requested during another operation instead of dropping it", async () => {
    const atoms = createEditorSyncAtoms();
    const firstSave = createDeferred();
    const calls: string[] = [];

    const { result } = renderHook(() =>
      useKBEditorSync({
        isPublishingAtom: atoms.isPublishingAtom,
        saveStatusAtom: atoms.saveStatusAtom,
        publishHandlerAtom: atoms.publishHandlerAtom,
      })
    );

    const first = result.current.performSafeAction(async () => {
      calls.push("first:start");
      await firstSave.promise;
      calls.push("first:end");
      return "first";
    });

    await waitFor(() => expect(calls).toEqual(["first:start"]));

    const second = result.current.performSafeAction(async () => {
      calls.push("second");
      return "second";
    });

    await Promise.resolve();
    expect(calls).toEqual(["first:start"]);

    firstSave.resolve();

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(calls).toEqual(["first:start", "first:end", "second"]);
  });

  it("keeps a user-triggered publish valid while it waits for an active save", async () => {
    const now = jest.spyOn(Date, "now").mockReturnValue(0);
    const atoms = createEditorSyncAtoms();
    const activeSave = createDeferred();
    const calls: string[] = [];

    const { result } = renderHook(() => {
      const sync = useKBEditorSync({
        isPublishingAtom: atoms.isPublishingAtom,
        saveStatusAtom: atoms.saveStatusAtom,
        publishHandlerAtom: atoms.publishHandlerAtom,
      });
      return {
        sync,
        publishHandler: useAtomValue(atoms.publishHandlerAtom),
      };
    });

    const save = result.current.sync.performSafeAction(async () => {
      calls.push("save:start");
      await activeSave.promise;
      calls.push("save:end");
    });

    await waitFor(() => expect(calls).toEqual(["save:start"]));
    now.mockReturnValue(1500);

    act(() => {
      result.current.sync.registerPublishHandler(async () => {
        await result.current.sync.performSafeAction(
          async () => {
            calls.push("publish");
          },
          { isPublish: true }
        );
      });
    });

    await waitFor(() => expect(result.current.publishHandler).toBeTruthy());

    const publish = result.current.publishHandler?.();

    await Promise.resolve();
    expect(calls).toEqual(["save:start"]);

    activeSave.resolve();

    await expect(save).resolves.toBeUndefined();
    await expect(publish).resolves.toBeUndefined();
    expect(calls).toEqual(["save:start", "save:end", "publish"]);
  });
});
