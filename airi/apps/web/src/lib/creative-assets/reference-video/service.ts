import "server-only";

import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { serializeCanonicalJson } from "@icecore/shared/lib/canonical-json";
import {
  checkCriticalRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import connectDB from "@/lib/mongoose";
import {
  CreativeVideoPlan,
  type ICreativeVideoPlan,
} from "@/models/creative-video-plan";
import { withWorkspaceCreativeGenerationAdmission } from "../creative-generation-admission";
import {
  referenceVideoPlanApprovalSchema,
  referenceVideoPlanIdSchema,
  REFERENCE_VIDEO_PLAN_VERSION,
  type ReferenceVideoPlan,
} from "./contracts";
import {
  buildReferenceVideoPlanSnapshot,
  type ReferenceVideoPlanSnapshot,
} from "./plan";
import { queueTimelineRender } from "../timeline/queue";
import {
  TimelineRenderValidationError,
  validateTimelineSources,
} from "../timeline/sources";
import { timelineSchema } from "../timeline/schema";
import { ZodError } from "zod";

const PLAN_LIFETIME_MS = 30 * 60_000;
const DRAFT_LIMIT = 20;
const APPROVAL_LIMIT = 10;
const draftLimiter = createRateLimiter({
  requests: DRAFT_LIMIT,
  window: "1 h",
  prefix: "assets:reference-video-draft",
  analytics: false,
});
const approvalLimiter = createRateLimiter({
  requests: APPROVAL_LIMIT,
  window: "1 h",
  prefix: "assets:reference-video-approval",
  analytics: false,
});

export class ReferenceVideoPlanError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 429 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ReferenceVideoPlanError";
  }
}

async function enforceRateLimit(
  workspaceId: string,
  action: "draft" | "approve"
) {
  const limiter = action === "draft" ? draftLimiter : approvalLimiter;
  const limit = action === "draft" ? DRAFT_LIMIT : APPROVAL_LIMIT;
  const unavailable = () =>
    new ReferenceVideoPlanError(
      503,
      "plan_rate_limit_unavailable",
      "Video planning is temporarily unavailable. Please retry."
    );
  const result = await checkCriticalRateLimit(limiter, workspaceId);
  if (
    result.status === "unavailable" ||
    result.limit !== limit ||
    !Number.isFinite(result.reset) ||
    result.reset <= 0
  )
    throw unavailable();
  if (result.status === "limited")
    throw new ReferenceVideoPlanError(
      429,
      "plan_rate_limit_exceeded",
      "This workspace has reached its video planning limit. Please try again later."
    );
}

function planHash(
  plan: Pick<
    ICreativeVideoPlan,
    "_id" | "workspaceId" | "snapshot" | "outputAssetId" | "expiresAt"
  >
): string {
  return createHash("sha256")
    .update(
      serializeCanonicalJson({
        id: plan._id,
        workspaceId: plan.workspaceId,
        snapshot: plan.snapshot,
        outputAssetId: plan.outputAssetId,
        expiresAt: plan.expiresAt.toISOString(),
      })
    )
    .digest("hex");
}

function serializePlan(plan: ICreativeVideoPlan): ReferenceVideoPlan {
  const { recipeId, recipeVersion, title, reference, scenes, duration, cost } =
    plan.snapshot;
  return {
    recipeId,
    recipeVersion,
    title,
    ...(reference ? { reference } : {}),
    scenes,
    duration,
    cost,
    id: plan._id,
    hash: plan.hash,
    expiresAt: plan.expiresAt.toISOString(),
    outputAssetId: plan.outputAssetId,
    status: plan.status,
  };
}

async function validatePlanSources(
  plan: Pick<ICreativeVideoPlan, "workspaceId" | "snapshot">
) {
  try {
    await validateTimelineSources(
      plan.workspaceId,
      timelineSchema.parse(plan.snapshot.timeline)
    );
  } catch (error) {
    if (
      !(error instanceof TimelineRenderValidationError) &&
      !(error instanceof ZodError)
    )
      throw error;
    throw new ReferenceVideoPlanError(
      400,
      "invalid_plan_sources",
      "Choose available, completed images or videos from this workspace for every scene."
    );
  }
}

export async function createReferenceVideoPlan(input: {
  workspaceId: string;
  userId: string;
  input: unknown;
}): Promise<ReferenceVideoPlan> {
  let snapshot: ReferenceVideoPlanSnapshot;
  try {
    snapshot = buildReferenceVideoPlanSnapshot(input.input);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new ReferenceVideoPlanError(
      400,
      "invalid_reference_video_plan",
      error.issues[0]?.message || "Invalid video plan"
    );
  }
  await enforceRateLimit(input.workspaceId, "draft");
  await connectDB();
  const now = new Date();
  const plan: ICreativeVideoPlan = {
    _id: new Types.ObjectId().toHexString(),
    workspaceId: input.workspaceId,
    createdBy: input.userId,
    snapshot,
    outputAssetId: new Types.ObjectId().toHexString(),
    expiresAt: new Date(now.getTime() + PLAN_LIFETIME_MS),
    status: "draft",
    hash: "",
    approvedAt: null,
    approvedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await validatePlanSources(plan);
  plan.hash = planHash(plan);
  await CreativeVideoPlan.create(plan);
  return serializePlan(plan);
}

function validateApproval(plan: ICreativeVideoPlan, hash: string) {
  let intact = false;
  try {
    intact =
      plan.hash === hash &&
      planHash(plan) === hash &&
      plan.snapshot.recipeVersion === REFERENCE_VIDEO_PLAN_VERSION &&
      plan.snapshot.cost.amount === 0 &&
      plan.snapshot.cost.currency === "USD" &&
      plan.snapshot.cost.generatedSeconds === 0 &&
      plan.snapshot.timeline.canvas === "9:16";
  } catch {
    // Invalid persisted metadata must never become an executable render.
  }
  if (!intact)
    throw new ReferenceVideoPlanError(
      409,
      "plan_hash_mismatch",
      "The video plan changed. Review and save a new plan before approving."
    );
  if (plan.status === "draft" && plan.expiresAt.getTime() <= Date.now())
    throw new ReferenceVideoPlanError(
      410,
      "plan_expired",
      "This video plan has expired. Review and save a new plan."
    );
}

async function loadPlan(
  workspaceId: string,
  planId: string
): Promise<ICreativeVideoPlan> {
  const plan = await CreativeVideoPlan.findOne({
    _id: planId,
    workspaceId,
  }).lean<ICreativeVideoPlan | null>();
  if (!plan)
    throw new ReferenceVideoPlanError(
      404,
      "plan_not_found",
      "Video plan not found"
    );
  return plan;
}

export async function approveReferenceVideoPlan(input: {
  workspaceId: string;
  userId: string;
  planId: string;
  hash: string;
}) {
  if (
    !referenceVideoPlanIdSchema.safeParse(input.planId).success ||
    !referenceVideoPlanApprovalSchema.safeParse({ hash: input.hash }).success
  )
    throw new ReferenceVideoPlanError(
      400,
      "invalid_plan_approval",
      "Invalid video plan approval"
    );
  await connectDB();
  let plan = await loadPlan(input.workspaceId, input.planId);
  validateApproval(plan, input.hash);
  if (plan.status === "draft") {
    plan = await withWorkspaceCreativeGenerationAdmission(
      input.workspaceId,
      async () => {
        // Reload under the existing workspace lease so concurrent retries share the allowance.
        const current = await loadPlan(input.workspaceId, input.planId);
        validateApproval(current, input.hash);
        if (current.status === "approved") return current;
        await validatePlanSources(current);
        await enforceRateLimit(input.workspaceId, "approve");
        const now = new Date();
        const approved = await CreativeVideoPlan.findOneAndUpdate(
          {
            _id: input.planId,
            workspaceId: input.workspaceId,
            hash: input.hash,
            status: "draft",
            expiresAt: { $gt: now },
          },
          {
            $set: {
              status: "approved",
              approvedAt: now,
              approvedBy: input.userId,
            },
          },
          { new: true }
        ).lean<ICreativeVideoPlan | null>();
        if (approved) return approved;
        const winner = await loadPlan(input.workspaceId, input.planId);
        validateApproval(winner, input.hash);
        if (winner.status !== "approved")
          throw new ReferenceVideoPlanError(
            409,
            "plan_approval_conflict",
            "Video plan approval is busy. Please retry."
          );
        return winner;
      }
    );
  } else {
    await validatePlanSources(plan);
  }
  try {
    const result = await queueTimelineRender({
      workspaceId: input.workspaceId,
      userId: input.userId,
      sourceAssetId: plan.snapshot.scenes[0].assetId,
      timeline: plan.snapshot.timeline,
      title: plan.snapshot.title,
      outputAssetId: plan.outputAssetId,
      planId: plan._id,
    });
    return { plan: serializePlan(plan), ...result };
  } catch {
    throw new ReferenceVideoPlanError(
      503,
      "plan_render_unavailable",
      "Your video plan is approved. Retry to resume the same render."
    );
  }
}
