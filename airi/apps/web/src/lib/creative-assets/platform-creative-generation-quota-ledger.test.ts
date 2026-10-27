jest.mock("@/lib/mongoose", () => ({ __esModule: true, default: jest.fn() }));
import {
  CreativeGenerationAdmissionBusyError,
  type CreativeGenerationAdmissionFence,
} from "./creative-generation-admission";
import {
  getWorkspacePlatformCreativeGenerationUsage,
  PLATFORM_CREATIVE_GENERATION_COUNTED_ASSET_FILTER,
  PLATFORM_CREATIVE_GENERATION_QUOTA_POLICY_REVISION,
  withWorkspacePlatformCreativeGenerationQuotaAdmission,
  type PlatformCreativeGenerationQuotaClaim,
  type PlatformCreativeGenerationQuotaLedgerDependencies,
} from "./platform-creative-generation-quota-ledger";
import { PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX } from "@/models/platform-creative-generation-quota-claim";

function createLedgerState(existingAssetIds: string[] = []) {
  const claims = new Map<string, PlatformCreativeGenerationQuotaClaim>();
  let assets = [...existingAssetIds];
  const listLimits: number[] = [];
  let admissionTail = Promise.resolve();
  let nextFencingToken = 0;
  let control = {
    policyRevision: 0,
    fencingToken: 0,
    limit: 0,
    reservations: [] as PlatformCreativeGenerationQuotaClaim[],
  };
  const ensureIndexes = jest.fn(async () => undefined);

  const appendReservation = (
    input: Parameters<
      PlatformCreativeGenerationQuotaLedgerDependencies["reserveClaim"]
    >[0]
  ):
    | {
        status: "reserved";
        claim: PlatformCreativeGenerationQuotaClaim;
        replay: boolean;
      }
    | { status: "full" }
    | { status: "stale" } => {
    if (
      control.fencingToken !== input.fencingToken ||
      control.limit !== input.limit
    ) {
      return { status: "stale" };
    }
    const existing =
      control.reservations.find(
        claim =>
          claim.claimId === input.claim.claimId ||
          claim.assetId === input.claim.assetId
      ) || null;
    if (existing) {
      claims.set(existing.claimId, existing);
      return { status: "reserved", claim: existing, replay: true };
    }
    if (control.reservations.length >= input.limit) {
      return { status: "full" };
    }
    const occupied = new Set(
      control.reservations.map(claim => claim.quotaSlot)
    );
    const preferred =
      "quotaSlot" in input.claim ? input.claim.quotaSlot : undefined;
    const quotaSlot =
      typeof preferred === "number" &&
      preferred >= 0 &&
      preferred < input.limit &&
      !occupied.has(preferred)
        ? preferred
        : Array.from({ length: input.limit }, (_, slot) => slot).find(
            slot => !occupied.has(slot)
          );
    if (quotaSlot === undefined) return { status: "full" };
    const stored: PlatformCreativeGenerationQuotaClaim = {
      ...input.claim,
      quotaSlot,
    };
    control.reservations.push(stored);
    claims.set(stored.claimId, stored);
    return { status: "reserved", claim: stored, replay: false };
  };

  const dependencies: PlatformCreativeGenerationQuotaLedgerDependencies = {
    ensureIndexes,
    async listCountedAssetIds(_workspaceId, limit) {
      listLimits.push(limit);
      return assets.slice(0, limit);
    },
    async listStoredClaims(_workspaceId, limit) {
      return [...claims.values()].slice(0, limit);
    },
    async activatePolicy(input) {
      if (input.fencingToken < control.fencingToken) return false;
      if (input.policyRevision < control.policyRevision) return false;
      if (
        input.policyRevision === control.policyRevision &&
        input.limit > control.limit
      ) {
        return false;
      }
      control = {
        ...control,
        policyRevision: input.policyRevision,
        fencingToken: input.fencingToken,
        limit: input.limit,
      };
      return true;
    },
    async reconcileClaims(input) {
      for (const claim of input.claims) {
        const result = appendReservation({
          workspaceId: input.workspaceId,
          fencingToken: input.fencingToken,
          limit: input.limit,
          claim,
        });
        if (result.status === "stale") return "stale";
        if (result.status === "full") break;
      }
      return "active";
    },
    async reserveClaim(input) {
      return appendReservation(input);
    },
    async getUsage(input) {
      return control.fencingToken === input.fencingToken &&
        control.limit === input.limit
        ? Math.min(control.reservations.length, input.limit)
        : null;
    },
    async withWorkspaceAdmission(_workspaceId, run) {
      const previous = admissionTail;
      let release!: () => void;
      admissionTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;
      try {
        nextFencingToken += 1;
        return await run({
          workspaceId: _workspaceId,
          ownerToken: `owner-${nextFencingToken}`,
          fencingToken: nextFencingToken,
        });
      } finally {
        release();
      }
    },
  };

  return {
    claims,
    dependencies,
    ensureIndexes,
    listLimits,
    removeAllAssets() {
      assets = [];
    },
    setAssets(next: string[]) {
      assets = [...next];
    },
    concurrentAdmission() {
      dependencies.withWorkspaceAdmission = async (workspaceId, run) => {
        nextFencingToken += 1;
        const fencingToken = nextFencingToken;
        const fence: CreativeGenerationAdmissionFence = {
          workspaceId,
          ownerToken: `owner-${fencingToken}`,
          fencingToken,
        };
        return run(fence);
      };
    },
  };
}

describe("platform creative generation quota ledger", () => {
  it("defines a unique partial capacity-slot fence per workspace", () => {
    expect(PLATFORM_CREATIVE_GENERATION_QUOTA_CLAIM_SLOT_INDEX).toEqual({
      key: { workspaceId: 1, quotaSlot: 1 },
      options: {
        name: "workspace_platform_creative_generation_claim_slot",
        unique: true,
        partialFilterExpression: {
          recordType: "claim",
          quotaSlot: { $type: "number" },
        },
      },
    });
  });

  it("excludes provider-result recovery children from legacy bootstrap", () => {
    expect(PLATFORM_CREATIVE_GENERATION_COUNTED_ASSET_FILTER).toEqual({
      $or: [
        {
          provider: "google",
          $or: [
            { providerSourceId: null },
            { providerSourceId: "" },
            { providerSourceId: { $exists: false } },
          ],
        },
        {
          provider: "elevenlabs",
          $or: [
            { providerSourceId: null },
            { providerSourceId: "" },
            { providerSourceId: { $exists: false } },
          ],
        },
      ],
      status: { $in: ["queued", "in_progress", "complete", "nsfw"] },
      "generation.recoveryMode": null,
    });
  });

  it("bootstraps existing counted assets once and survives hard deletion", async () => {
    const state = createLedgerState(["asset-1", "asset-2"]);

    await expect(
      getWorkspacePlatformCreativeGenerationUsage(
        "workspace-1",
        10,
        state.dependencies
      )
    ).resolves.toBe(2);

    state.removeAllAssets();

    await expect(
      getWorkspacePlatformCreativeGenerationUsage(
        "workspace-1",
        10,
        state.dependencies
      )
    ).resolves.toBe(2);
    expect(state.listLimits).toEqual([10, 10, 10, 10, 10]);
    expect(state.ensureIndexes).toHaveBeenCalled();
  });

  it("serializes concurrent first reads so bootstrap claims are inserted once", async () => {
    const state = createLedgerState(["asset-1", "asset-2"]);

    await expect(
      Promise.all([
        getWorkspacePlatformCreativeGenerationUsage(
          "workspace-1",
          10,
          state.dependencies
        ),
        getWorkspacePlatformCreativeGenerationUsage(
          "workspace-1",
          10,
          state.dependencies
        ),
      ])
    ).resolves.toEqual([2, 2]);

    expect(state.listLimits).toEqual([10, 10, 10, 10, 10]);
  });

  it("never over-admits when an expired lease lets distinct claims overlap", async () => {
    const state = createLedgerState();
    state.concurrentAdmission();
    const firstRun = jest.fn(async () => "first");
    const secondRun = jest.fn(async () => "second");

    const results = await Promise.allSettled([
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 1,
          claimKey: "request-1",
          assetId: "asset-1",
        },
        firstRun,
        state.dependencies
      ),
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 1,
          claimKey: "request-2",
          assetId: "asset-2",
        },
        secondRun,
        state.dependencies
      ),
    ]);

    expect(
      results.filter(
        result => result.status === "fulfilled" && result.value.accepted
      )
    ).toHaveLength(1);
    expect(
      results.filter(
        result =>
          result.status === "rejected" &&
          result.reason instanceof CreativeGenerationAdmissionBusyError
      )
    ).toHaveLength(1);
    expect(state.claims.size).toBe(1);
    expect(firstRun.mock.calls.length + secondRun.mock.calls.length).toBe(1);
  });

  it("rejects a stale higher-limit owner after a newer lower-limit policy wins", async () => {
    const state = createLedgerState();
    state.concurrentAdmission();
    const activatePolicy = state.dependencies.activatePolicy;
    let notifyHighActivated!: () => void;
    const highActivated = new Promise<void>(resolve => {
      notifyHighActivated = resolve;
    });
    let releaseHigh!: () => void;
    const highMayContinue = new Promise<void>(resolve => {
      releaseHigh = resolve;
    });
    state.dependencies.activatePolicy = async input => {
      const active = await activatePolicy(input);
      if (input.fencingToken === 1) {
        notifyHighActivated();
        await highMayContinue;
      }
      return active;
    };
    const highRun = jest.fn(async () => "stale-high");
    const lowRun = jest.fn(async () => "current-low");
    const highOutcome = withWorkspacePlatformCreativeGenerationQuotaAdmission(
      {
        workspaceId: "workspace-1",
        limit: 100,
        claimKey: "request-high",
        assetId: "asset-high",
      },
      highRun,
      state.dependencies
    ).then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason })
    );

    await highActivated;
    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 1,
          claimKey: "request-low",
          assetId: "asset-low",
        },
        lowRun,
        state.dependencies
      )
    ).resolves.toMatchObject({ accepted: true, quota: { limit: 1, used: 1 } });
    releaseHigh();

    await expect(highOutcome).resolves.toMatchObject({
      status: "rejected",
      reason: expect.any(CreativeGenerationAdmissionBusyError),
    });
    expect(highRun).not.toHaveBeenCalled();
    expect(lowRun).toHaveBeenCalledTimes(1);
    expect(state.claims.size).toBe(1);
  });

  it("does not let a later old-config owner raise a limit in the same policy revision", async () => {
    const state = createLedgerState();
    const currentRun = jest.fn(async () => "current");
    const oldConfigRun = jest.fn(async () => "old-config");

    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 1,
          claimKey: "request-current",
          assetId: "asset-current",
        },
        currentRun,
        state.dependencies
      )
    ).resolves.toMatchObject({ accepted: true, quota: { limit: 1, used: 1 } });

    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 100,
          claimKey: "request-old-config",
          assetId: "asset-old-config",
        },
        oldConfigRun,
        state.dependencies
      )
    ).rejects.toBeInstanceOf(CreativeGenerationAdmissionBusyError);
    expect(PLATFORM_CREATIVE_GENERATION_QUOTA_POLICY_REVISION).toBe(1);
    expect(currentRun).toHaveBeenCalledTimes(1);
    expect(oldConfigRun).not.toHaveBeenCalled();
    expect(state.claims.size).toBe(1);
  });

  it("reconciles a legacy write that lands between bootstrap scans", async () => {
    const state = createLedgerState(["asset-1"]);
    const listCountedAssetIds = state.dependencies.listCountedAssetIds;
    let scans = 0;
    state.dependencies.listCountedAssetIds = async (workspaceId, limit) => {
      const result = await listCountedAssetIds(workspaceId, limit);
      scans += 1;
      if (scans === 1) {
        state.setAssets(["asset-1", "asset-2"]);
      }
      return result;
    };
    const run = jest.fn(async () => "should-not-run");

    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 2,
          claimKey: "request-1",
          assetId: "asset-3",
        },
        run,
        state.dependencies
      )
    ).resolves.toEqual({
      accepted: false,
      quota: { limit: 2, used: 2, remaining: 0 },
    });
    expect(scans).toBeGreaterThanOrEqual(3);
    expect(run).not.toHaveBeenCalled();
    expect(state.claims.size).toBe(2);
  });

  it("replays the deterministic winner after same-key expired owners overlap", async () => {
    const state = createLedgerState();
    state.concurrentAdmission();
    const reservations: Array<{ assetId: string; replay: boolean }> = [];

    const results = await Promise.allSettled([
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 1,
          claimKey: "request-1",
          assetId: "asset-1",
        },
        async reservation => {
          reservations.push(reservation);
          return "first";
        },
        state.dependencies
      ),
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 1,
          claimKey: "request-1",
          assetId: "asset-2",
        },
        async reservation => {
          reservations.push(reservation);
          return "replay";
        },
        state.dependencies
      ),
    ]);

    expect(
      results.filter(result => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(reservations).toHaveLength(1);
    const winnerAssetId = reservations[0]!.assetId;
    const replay = await withWorkspacePlatformCreativeGenerationQuotaAdmission(
      {
        workspaceId: "workspace-1",
        limit: 1,
        claimKey: "request-1",
        assetId: "asset-3",
      },
      async reservation => reservation,
      state.dependencies
    );
    expect(replay).toMatchObject({
      accepted: true,
      replay: true,
      value: { assetId: winnerAssetId, replay: true },
    });
    expect(state.claims.size).toBe(1);
  });

  it("caps bootstrap and usage reads at the configured limit", async () => {
    const state = createLedgerState(
      Array.from({ length: 20 }, (_, index) => `asset-${index}`)
    );

    await expect(
      getWorkspacePlatformCreativeGenerationUsage(
        "workspace-large",
        3,
        state.dependencies
      )
    ).resolves.toBe(3);

    expect(state.listLimits).toEqual([3, 3, 3]);
    expect(state.claims.size).toBe(3);
  });

  it("does not scan at zero and requires a policy revision for a later increase", async () => {
    const state = createLedgerState(["asset-1", "asset-2"]);

    await expect(
      getWorkspacePlatformCreativeGenerationUsage(
        "workspace-1",
        0,
        state.dependencies
      )
    ).resolves.toBe(0);
    expect(state.listLimits).toEqual([]);

    await expect(
      getWorkspacePlatformCreativeGenerationUsage(
        "workspace-1",
        2,
        state.dependencies
      )
    ).rejects.toBeInstanceOf(CreativeGenerationAdmissionBusyError);
    expect(state.listLimits).toEqual([]);
  });

  it("rejects a new claim at limit zero without running generation", async () => {
    const state = createLedgerState();
    const run = jest.fn(async () => "generated");

    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 0,
          claimKey: "request-1",
          assetId: "asset-1",
        },
        run,
        state.dependencies
      )
    ).resolves.toEqual({
      accepted: false,
      quota: { limit: 0, used: 0, remaining: 0 },
    });
    expect(run).not.toHaveBeenCalled();
    expect(state.listLimits).toEqual([]);
  });

  it("replays the same request claim without consuming another slot", async () => {
    const state = createLedgerState();
    const seenReservations: Array<{ assetId: string; replay: boolean }> = [];

    const first = await withWorkspacePlatformCreativeGenerationQuotaAdmission(
      {
        workspaceId: "workspace-1",
        limit: 10,
        claimKey: "request-1",
        assetId: "asset-1",
      },
      async reservation => {
        seenReservations.push(reservation);
        return "first";
      },
      state.dependencies
    );
    const replay = await withWorkspacePlatformCreativeGenerationQuotaAdmission(
      {
        workspaceId: "workspace-1",
        limit: 10,
        claimKey: "request-1",
        assetId: "asset-2",
      },
      async reservation => {
        seenReservations.push(reservation);
        return "replay";
      },
      state.dependencies
    );

    expect(first).toMatchObject({
      accepted: true,
      replay: false,
      value: "first",
      quota: { used: 1, remaining: 9 },
    });
    expect(replay).toMatchObject({
      accepted: true,
      replay: true,
      value: "replay",
      quota: { used: 1, remaining: 9 },
    });
    expect(seenReservations).toEqual([
      { assetId: "asset-1", replay: false },
      { assetId: "asset-1", replay: true },
    ]);
    expect(state.claims.size).toBe(1);
  });

  it("does not run a distinct request after the final slot is consumed", async () => {
    const state = createLedgerState(["asset-1"]);
    const firstRun = jest.fn(async () => "first");
    const blockedRun = jest.fn(async () => "blocked");

    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 2,
          claimKey: "request-1",
          assetId: "asset-2",
        },
        firstRun,
        state.dependencies
      )
    ).resolves.toMatchObject({
      accepted: true,
      quota: { used: 2, remaining: 0 },
    });

    await expect(
      withWorkspacePlatformCreativeGenerationQuotaAdmission(
        {
          workspaceId: "workspace-1",
          limit: 2,
          claimKey: "request-2",
          assetId: "asset-3",
        },
        blockedRun,
        state.dependencies
      )
    ).resolves.toEqual({
      accepted: false,
      quota: { limit: 2, used: 2, remaining: 0 },
    });
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(blockedRun).not.toHaveBeenCalled();
  });
});
