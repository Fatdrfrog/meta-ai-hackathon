const mockConnectDB = jest.fn();
const mockFindOne = jest.fn();
const mockCreate = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockValidateTimelineSources = jest.fn();
const mockQueueTimelineRender = jest.fn();
const mockCheckCriticalRateLimit = jest.fn();

jest.mock("@/lib/mongoose", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockConnectDB(...args),
}));
jest.mock("@/models/creative-video-plan", () => ({
  CreativeVideoPlan: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
}));
jest.mock("@/lib/creative-assets/timeline/sources", () => ({
  TimelineRenderValidationError: class extends Error {},
  validateTimelineSources: (...args: unknown[]) =>
    mockValidateTimelineSources(...args),
}));
jest.mock("@/lib/creative-assets/timeline/queue", () => ({
  queueTimelineRender: (...args: unknown[]) => mockQueueTimelineRender(...args),
}));
jest.mock("@icecore/shared/lib/rate-limiter", () => ({
  createRateLimiter: (config: unknown) => config,
  checkCriticalRateLimit: (...args: unknown[]) =>
    mockCheckCriticalRateLimit(...args),
}));
jest.mock("@/lib/creative-assets/creative-generation-admission", () => ({
  withWorkspaceCreativeGenerationAdmission: async (
    _workspaceId: string,
    run: () => Promise<unknown>
  ) => run(),
}));

import { approveReferenceVideoPlan, createReferenceVideoPlan } from "./service";
import type { ICreativeVideoPlan } from "@/models/creative-video-plan";
import { REFERENCE_VIDEO_RECIPES } from "./recipes";
import { TimelineRenderValidationError } from "../timeline/sources";

const WORKSPACE = "workspace-1";
const INPUT = {
  recipeId: "product-reveal",
  title: "Our new collection",
  scenes: [
    {
      assetId: "64c13ab08edf48a008793ca1",
      caption: "Meet your new favorite",
      sourceStart: 0,
    },
    {
      assetId: "64c13ab08edf48a008793ca2",
      caption: "Made for everyday",
      sourceStart: 0,
    },
    {
      assetId: "64c13ab08edf48a008793ca3",
      caption: "Explore the collection",
      sourceStart: 0,
    },
  ],
};

let stored: ICreativeVideoPlan | null;
function lean(value: unknown) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-09-05T12:00:00Z"));
  stored = null;
  mockConnectDB.mockResolvedValue(undefined);
  mockValidateTimelineSources.mockResolvedValue(undefined);
  mockCheckCriticalRateLimit.mockImplementation(async limiter => ({
    status: "granted",
    limit: limiter.requests,
    remaining: limiter.requests - 1,
    reset: Date.now() + 3_600_000,
  }));
  mockCreate.mockImplementation(async data => {
    stored = structuredClone(data);
    return stored;
  });
  mockFindOne.mockImplementation(query =>
    lean(
      stored &&
        query.workspaceId === stored.workspaceId &&
        String(query._id) === String(stored._id)
        ? structuredClone(stored)
        : null
    )
  );
  mockFindOneAndUpdate.mockImplementation((query, update) => {
    if (
      !stored ||
      stored.status !== query.status ||
      stored.hash !== query.hash ||
      stored.expiresAt <= query.expiresAt.$gt
    )
      return lean(null);
    stored = { ...stored, ...structuredClone(update.$set) };
    return lean(structuredClone(stored));
  });
  mockQueueTimelineRender.mockImplementation(async input => ({
    asset: {
      _id: input.outputAssetId,
      status: "queued",
      workspaceId: input.workspaceId,
    },
    duplicate: false,
  }));
});

afterEach(() => jest.useRealTimers());

async function draft() {
  return createReferenceVideoPlan({
    workspaceId: WORKSPACE,
    userId: "user-1",
    input: INPUT,
  });
}

async function approve(plan: { id: string; hash: string }, overrides = {}) {
  return approveReferenceVideoPlan({
    workspaceId: WORKSPACE,
    userId: "user-1",
    planId: plan.id,
    hash: plan.hash,
    ...overrides,
  });
}

test("saving a reviewed draft reserves one output ID without dispatching render work", async () => {
  const plan = await draft();
  expect(plan).toEqual(
    expect.objectContaining({
      status: "draft",
      recipeId: "product-reveal",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expiresAt: "2026-09-05T12:30:00.000Z",
      outputAssetId: expect.stringMatching(/^[a-f0-9]{24}$/),
      cost: { amount: 0, currency: "USD", generatedSeconds: 0 },
    })
  );
  expect(plan).not.toHaveProperty("timeline");
  expect(mockValidateTimelineSources).toHaveBeenCalledWith(
    WORKSPACE,
    expect.objectContaining({ canvas: "9:16" })
  );
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("only explicit approval of the exact hash dispatches the frozen timeline and reserved output", async () => {
  const plan = await draft();
  const snapshot = structuredClone(stored!.snapshot);
  const result = await approve(plan);
  expect(result.plan.status).toBe("approved");
  expect(mockQueueTimelineRender).toHaveBeenCalledWith({
    workspaceId: WORKSPACE,
    userId: "user-1",
    sourceAssetId: INPUT.scenes[0].assetId,
    timeline: snapshot.timeline,
    title: INPUT.title,
    outputAssetId: plan.outputAssetId,
    planId: plan.id,
  });
  expect(mockValidateTimelineSources).toHaveBeenCalledTimes(2);
});

test("rejects changed hashes before consuming approval quota or queueing output", async () => {
  const plan = await draft();
  mockCheckCriticalRateLimit.mockClear();
  await expect(approve(plan, { hash: "a".repeat(64) })).rejects.toMatchObject({
    status: 409,
  });
  expect(mockCheckCriticalRateLimit).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("first approval rejects expired drafts", async () => {
  const plan = await draft();
  jest.setSystemTime(new Date("2026-09-05T12:30:00Z"));
  await expect(approve(plan)).rejects.toMatchObject({ status: 410 });
  expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("workspace isolation hides another workspace's plan", async () => {
  const plan = await draft();
  await expect(
    approve(plan, { workspaceId: "workspace-2" })
  ).rejects.toMatchObject({ status: 404 });
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("rejects invalid selected assets before persisting a draft", async () => {
  mockValidateTimelineSources.mockRejectedValue(
    new TimelineRenderValidationError("private asset details")
  );
  await expect(draft()).rejects.toMatchObject({
    status: 400,
    code: "invalid_plan_sources",
  });
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("revalidates source ownership and completion when approving", async () => {
  const plan = await draft();
  mockValidateTimelineSources.mockRejectedValue(
    new TimelineRenderValidationError("deleted or foreign asset")
  );
  await expect(approve(plan)).rejects.toMatchObject({
    status: 400,
    code: "invalid_plan_sources",
  });
  expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("preserves source storage failures before persisting a draft", async () => {
  const storageError = new Error("MongoServerSelectionError: private host");
  mockValidateTimelineSources.mockRejectedValue(storageError);

  await expect(draft()).rejects.toBe(storageError);

  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test.each(["draft", "approved"])(
  "preserves source storage failures while keeping the %s plan retryable",
  async status => {
    const plan = await draft();
    if (status === "approved") await approve(plan);
    mockFindOneAndUpdate.mockClear();
    mockQueueTimelineRender.mockClear();
    mockCheckCriticalRateLimit.mockClear();
    const storageError = new Error("MongoServerSelectionError: private host");
    mockValidateTimelineSources.mockRejectedValue(storageError);

    await expect(approve(plan)).rejects.toBe(storageError);

    expect(stored!.status).toBe(status);
    expect(stored!.outputAssetId).toBe(plan.outputAssetId);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockQueueTimelineRender).not.toHaveBeenCalled();
    expect(mockCheckCriticalRateLimit).not.toHaveBeenCalled();
  }
);

test("duplicate approval reuses the same output and does not spend approval quota again", async () => {
  const plan = await draft();
  await approve(plan);
  mockCheckCriticalRateLimit.mockClear();
  await approve(plan);
  expect(mockCheckCriticalRateLimit).not.toHaveBeenCalled();
  expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(
    mockQueueTimelineRender.mock.calls.map(([value]) => value.outputAssetId)
  ).toEqual([plan.outputAssetId, plan.outputAssetId]);
});

test("ambiguous dispatch remains approved and retries after quote expiry with the same output", async () => {
  const plan = await draft();
  mockQueueTimelineRender.mockRejectedValueOnce(
    new Error("Temporal start timed out")
  );
  await expect(approve(plan)).rejects.toMatchObject({
    status: 503,
    code: "plan_render_unavailable",
  });
  expect(stored!.status).toBe("approved");
  jest.setSystemTime(new Date("2026-09-06T12:00:00Z"));
  mockCheckCriticalRateLimit.mockClear();
  const result = await approve(plan);
  expect(result.asset._id).toBe(plan.outputAssetId);
  expect(mockCheckCriticalRateLimit).not.toHaveBeenCalled();
});

test("fails closed on rate-limit service errors", async () => {
  mockCheckCriticalRateLimit.mockResolvedValue({ status: "unavailable" });
  await expect(draft()).rejects.toMatchObject({
    status: 503,
    code: "plan_rate_limit_unavailable",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});

test("fails closed on the shared limiter's granted-looking timeout fallback", async () => {
  mockCheckCriticalRateLimit.mockResolvedValue({
    status: "granted",
    limit: 0,
    remaining: 0,
    reset: 0,
  });
  await expect(draft()).rejects.toMatchObject({
    status: 503,
    code: "plan_rate_limit_unavailable",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});

test("first approval is bounded separately from draft creation", async () => {
  const plan = await draft();
  mockCheckCriticalRateLimit.mockResolvedValue({
    status: "limited",
    limit: 10,
    remaining: 0,
    reset: Date.now() + 60_000,
  });
  await expect(approve(plan)).rejects.toMatchObject({ status: 429 });
  expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("rejects a persisted snapshot altered after its approval hash was issued", async () => {
  const plan = await draft();
  stored!.snapshot.scenes[0].caption = "Something else";
  await expect(approve(plan)).rejects.toMatchObject({ status: 409 });
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("validates draft shape before persistence", async () => {
  await expect(
    createReferenceVideoPlan({
      workspaceId: WORKSPACE,
      userId: "user-1",
      input: { ...INPUT, scenes: [] },
    })
  ).rejects.toMatchObject({ status: 400 });
  expect(mockCreate).not.toHaveBeenCalled();
});

test("rejects malformed TikTok references before quota or database access", async () => {
  await expect(
    createReferenceVideoPlan({
      workspaceId: WORKSPACE,
      userId: "user-1",
      input: {
        ...INPUT,
        reference: {
          providerVideoId: "123",
          shareUrl: "not a URL",
          title: "Reference",
        },
      },
    })
  ).rejects.toMatchObject({
    status: 400,
    code: "invalid_reference_video_plan",
  });
  expect(mockCheckCriticalRateLimit).not.toHaveBeenCalled();
  expect(mockConnectDB).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
});

test("a slow approval cannot accept a draft that expires before the atomic update", async () => {
  const plan = await draft();
  mockCheckCriticalRateLimit.mockImplementation(async limiter => {
    jest.setSystemTime(new Date("2026-09-05T12:31:00Z"));
    return {
      status: "granted",
      limit: limiter.requests,
      remaining: 1,
      reset: Date.now() + 60_000,
    };
  });
  await expect(approve(plan)).rejects.toMatchObject({ status: 410 });
  expect(mockQueueTimelineRender).not.toHaveBeenCalled();
  expect(stored!.status).toBe("draft");
});

test("approval renders the saved recipe version even after the catalog recipe changes", async () => {
  const plan = await draft();
  const scene = REFERENCE_VIDEO_RECIPES.find(
    recipe => recipe.id === "product-reveal"
  )!.scenes[0];
  const previousDuration = scene.duration;
  try {
    scene.duration = 20;
    await approve(plan);
    expect(
      mockQueueTimelineRender.mock.calls[0][0].timeline.clips[0].duration
    ).toBe(previousDuration);
  } finally {
    scene.duration = previousDuration;
  }
});
