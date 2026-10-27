import {
  registerKBTreeRefreshCallback,
  type KBTreeRefreshCallback,
} from "./kb-tree-refresh-registration";

describe("registerKBTreeRefreshCallback", () => {
  it("stores a callable refresh function without invoking it during registration", async () => {
    const refresh = jest.fn(async () => undefined);
    const holder: { stored: KBTreeRefreshCallback | null } = { stored: null };
    const setRefresh = jest.fn(update => {
      holder.stored =
        typeof update === "function" ? update(holder.stored) : update;
    });

    registerKBTreeRefreshCallback(setRefresh, refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(typeof holder.stored).toBe("function");

    if (!holder.stored) {
      throw new Error("Refresh callback was not stored");
    }
    await holder.stored();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
