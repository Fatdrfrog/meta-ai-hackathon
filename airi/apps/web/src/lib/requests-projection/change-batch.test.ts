import { createProjectionChangeBatchReader } from "./change-batch";

describe("projection change batches", () => {
  it("returns an empty idle batch and delivers the next arriving change immediately", async () => {
    let resolveNext!: (value: number | null) => void;
    const stream = {
      tryNext: jest
        .fn<Promise<number | null>, []>()
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveNext = resolve;
            })
        )
        .mockResolvedValue(null),
    };
    const reader = createProjectionChangeBatchReader(stream);
    expect(await reader.next()).toEqual([]);
    const next = reader.next();
    resolveNext(7);
    expect(await next).toEqual([7]);
    expect(stream.tryNext).toHaveBeenCalledTimes(3);
  });
  it("drains buffered changes in order without waiting for a full batch", async () => {
    const values = [1, 2, 3, null];
    const stream = { tryNext: jest.fn(async () => values.shift() ?? null) };
    const reader = createProjectionChangeBatchReader(stream);
    expect(await reader.next()).toEqual([1, 2, 3]);
  });

  it("caps the retained batch and leaves following changes for the next commit", async () => {
    const values = [1, 2, 3, null];
    const stream = { tryNext: jest.fn(async () => values.shift() ?? null) };
    const reader = createProjectionChangeBatchReader(stream, 2);
    expect(await reader.next()).toEqual([1, 2]);
    expect(stream.tryNext).toHaveBeenCalledTimes(2);
    expect(await reader.next()).toEqual([3]);
  });

  it("does not hold a live change behind an idle cursor or lose the pending read", async () => {
    jest.useFakeTimers();
    try {
      let resolvePending!: (value: number | null) => void;
      const stream = {
        tryNext: jest
          .fn<Promise<number | null>, []>()
          .mockResolvedValueOnce(1)
          .mockImplementationOnce(
            () =>
              new Promise(resolve => {
                resolvePending = resolve;
              })
          )
          .mockResolvedValue(null),
      };
      const reader = createProjectionChangeBatchReader(stream);
      const first = reader.next();
      await jest.advanceTimersByTimeAsync(1);
      expect(await first).toEqual([1]);
      expect(stream.tryNext).toHaveBeenCalledTimes(2);
      resolvePending(2);
      expect(await reader.next()).toEqual([2]);
      expect(stream.tryNext).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("propagates a read failure without silently advancing the caller checkpoint", async () => {
    const failure = new Error("cursor disconnected");
    const stream = {
      tryNext: jest
        .fn<Promise<number | null>, []>()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(failure),
    };
    await expect(createProjectionChangeBatchReader(stream).next()).rejects.toBe(
      failure
    );
  });
});
