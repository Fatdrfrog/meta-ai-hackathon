import {
  CreativeGenerationAdmissionBusyError,
  withWorkspaceCreativeGenerationAdmission,
  type CreativeGenerationAdmissionDependencies,
} from "./creative-generation-admission";

function dependencies(
  overrides: Partial<CreativeGenerationAdmissionDependencies> = {}
): CreativeGenerationAdmissionDependencies {
  return {
    newOwnerToken: jest.fn(() => "owner-1"),
    now: jest.fn(() => new Date("2026-07-23T00:00:00.000Z")),
    tryAcquire: jest.fn().mockResolvedValue(1),
    release: jest.fn().mockResolvedValue(undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
    retryDelaysMs: [0, 1, 1],
    ...overrides,
  };
}

describe("withWorkspaceCreativeGenerationAdmission", () => {
  it("retries a contended workspace lease before entering once", async () => {
    const deps = dependencies({
      tryAcquire: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(42),
    });
    const run = jest.fn().mockResolvedValue("accepted");

    await expect(
      withWorkspaceCreativeGenerationAdmission("workspace-1", run, deps)
    ).resolves.toBe("accepted");

    expect(deps.tryAcquire).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      ownerToken: "owner-1",
      fencingToken: 42,
    });
    expect(deps.release).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      ownerToken: "owner-1",
      fencingToken: 42,
    });
  });

  it("always releases the workspace lease when admission work fails", async () => {
    const deps = dependencies();

    await expect(
      withWorkspaceCreativeGenerationAdmission(
        "workspace-1",
        async () => {
          throw new Error("queue failed");
        },
        deps
      )
    ).rejects.toThrow("queue failed");

    expect(deps.release).toHaveBeenCalledTimes(1);
  });

  it("does not turn accepted work into a failure when lease cleanup fails", async () => {
    const deps = dependencies({
      release: jest.fn().mockRejectedValue(new Error("lease cleanup failed")),
    });

    await expect(
      withWorkspaceCreativeGenerationAdmission(
        "workspace-1",
        async () => "accepted",
        deps
      )
    ).resolves.toBe("accepted");

    expect(deps.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed after bounded contention without running admission work", async () => {
    const deps = dependencies({
      tryAcquire: jest.fn().mockResolvedValue(null),
    });
    const run = jest.fn();

    await expect(
      withWorkspaceCreativeGenerationAdmission("workspace-1", run, deps)
    ).rejects.toBeInstanceOf(CreativeGenerationAdmissionBusyError);

    expect(run).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.tryAcquire).toHaveBeenCalledTimes(3);
  });
});
