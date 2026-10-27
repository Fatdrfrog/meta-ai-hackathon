import { getAuthenticatedWorkspaceMembership } from "@/lib/auth/workspace-membership";
import {
  getCampaignDispatchStatus,
  setCampaignDispatchPaused,
} from "@/lib/campaign/campaign-history-store";
import { isCampaignOperationUuid } from "@/lib/campaign/campaign-operation-route-utils";
import type { CampaignPauseResponse } from "@/lib/campaign/campaign-operations-contracts";
import { logger } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isWorkspaceManagerRole } from "@/lib/supabase/company-users";
import {
  isBulkCampaignPauseUnsupportedError,
  signalBulkCampaignDispatchPause,
} from "@/lib/temporal/bulk-campaign-dispatch";
import { isTemporalSdkError } from "@/lib/temporal/sdk";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ campaignId: string }>;
};

const ACTIVE_DISPATCH_STATUSES = new Set(["queued", "scheduled", "running"]);

const pauseLocks = new Map<string, Promise<void>>();

async function withCampaignPauseLock<T>(
  campaignId: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = pauseLocks.get(campaignId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  pauseLocks.set(
    campaignId,
    previous.catch(() => undefined).then(() => current)
  );
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (pauseLocks.get(campaignId) === current) {
      pauseLocks.delete(campaignId);
    }
  }
}

function invalidRequest() {
  return NextResponse.json(
    {
      code: "invalid_request",
      error: "A valid campaign ID, workspaceId, and paused flag are required.",
    },
    { status: 400 }
  );
}

function parsePauseBody(body: unknown): {
  workspaceId: string;
  paused: boolean;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2) {
    return null;
  }
  const workspaceId = record.workspaceId;
  const paused = record.paused;
  if (!isCampaignOperationUuid(workspaceId) || typeof paused !== "boolean") {
    return null;
  }
  return { workspaceId, paused };
}

export async function POST(request: Request, context: RouteContext) {
  const { campaignId } = await context.params;
  if (!isCampaignOperationUuid(campaignId)) {
    return invalidRequest();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }

  const parsed = parsePauseBody(body);
  if (!parsed) {
    return invalidRequest();
  }
  const { workspaceId, paused } = parsed;

  const access = await getAuthenticatedWorkspaceMembership(workspaceId);
  if (access.error) {
    return access.error;
  }
  if (!isWorkspaceManagerRole(access.membership.role)) {
    return NextResponse.json(
      { code: "forbidden", error: "Forbidden" },
      { status: 403 }
    );
  }

  let status;
  try {
    status = await getCampaignDispatchStatus({
      supabase: supabaseAdmin,
      workspaceId,
      campaignId,
    });
  } catch (error) {
    logger.error("campaign.pause_status_load_failed", error, {
      event: "campaign.pause_status_load_failed",
      campaignId,
      workspaceId,
    });
    return NextResponse.json(
      {
        code: "campaign_pause_failed",
        error: "Campaign pause state could not be updated.",
        retryable: true,
      },
      { status: 503 }
    );
  }

  if (!status) {
    return NextResponse.json(
      { code: "campaign_not_found", error: "Campaign not found." },
      { status: 404 }
    );
  }
  if (!ACTIVE_DISPATCH_STATUSES.has(status.status)) {
    return NextResponse.json(
      {
        code: "campaign_not_pausable",
        error: "Campaign is no longer pausable.",
        status: status.status,
      },
      { status: 409 }
    );
  }
  const workflowId = status.workflowId;
  if (typeof workflowId !== "string" || !workflowId.trim()) {
    return NextResponse.json(
      {
        code: "temporal_pause_failed",
        error: "Campaign workflow pause could not be confirmed.",
        campaignId,
        retryable: true,
      },
      { status: 502 }
    );
  }

  return withCampaignPauseLock(campaignId, async () => {
    try {
      const temporalPause = await signalBulkCampaignDispatchPause({
        workflowId,
        paused,
      });
      if (temporalPause.paused !== paused) {
        return NextResponse.json(
          {
            code: "temporal_pause_failed",
            error: "Campaign workflow pause could not be confirmed.",
            campaignId,
            retryable: true,
          },
          { status: 502 }
        );
      }
    } catch (error) {
      if (isTemporalSdkError(error, "WorkflowNotFoundError")) {
        return NextResponse.json(
          {
            code: "campaign_not_pausable",
            error: "Campaign is no longer pausable.",
            status: status.status,
          },
          { status: 409 }
        );
      }
      if (isBulkCampaignPauseUnsupportedError(error)) {
        return NextResponse.json(
          {
            code: "workflow_pause_unsupported",
            error: "This campaign workflow does not support pause yet.",
            campaignId,
          },
          { status: 409 }
        );
      }
      logger.error("campaign.pause_temporal_failed", error, {
        event: "campaign.pause_temporal_failed",
        campaignId,
        workspaceId,
        paused,
      });
      return NextResponse.json(
        {
          code: "temporal_pause_failed",
          error: "Campaign workflow pause could not be confirmed.",
          campaignId,
          retryable: true,
        },
        { status: 502 }
      );
    }

    let localPause;
    try {
      localPause = await setCampaignDispatchPaused({
        supabase: supabaseAdmin,
        workspaceId,
        campaignId,
        paused,
      });
    } catch (error) {
      logger.error("campaign.pause_local_failed", error, {
        event: "campaign.pause_local_failed",
        campaignId,
        workspaceId,
        paused,
      });
      return NextResponse.json(
        {
          code: "campaign_pause_failed",
          error: "Campaign pause state could not be updated.",
          retryable: true,
        },
        { status: 503 }
      );
    }

    if (localPause.outcome === "not_found") {
      return NextResponse.json(
        { code: "campaign_not_found", error: "Campaign not found." },
        { status: 404 }
      );
    }
    if (
      localPause.outcome === "already_terminal" ||
      localPause.outcome === "not_cancellable"
    ) {
      return NextResponse.json(
        {
          code: "campaign_not_pausable",
          error: "Campaign is no longer pausable.",
          status: localPause.status,
        },
        { status: 409 }
      );
    }

    const response: CampaignPauseResponse = {
      campaignId,
      status: localPause.status,
      paused,
      outcome: localPause.outcome,
    };
    return NextResponse.json(response);
  });
}
