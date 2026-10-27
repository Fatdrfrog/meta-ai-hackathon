import { verifyCronAuth } from "@/lib/cron-auth";
import { collectDependencyHealth } from "@/lib/dependency-health";
import { createLogger } from "@icecore/shared/lib/logger";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_REALTIME_GATEWAY_TIMEOUT_MS = 20_000;
const dependencyHealthCronLogger = createLogger("cron-dependency-health");

export async function GET(request: Request) {
  try {
    const denied = verifyCronAuth(request);
    if (denied) return denied;

    const snapshot = await collectDependencyHealth({
      // Cron can afford a longer budget so Cloud Run scale-from-zero does not
      // look like a realtime gateway outage.
      timeouts: { realtime_gateway: CRON_REALTIME_GATEWAY_TIMEOUT_MS },
    });
    const { dependencies, status } = snapshot;
    const failing = Object.values(dependencies).filter(
      dependency =>
        dependency.status === "degraded" || dependency.status === "unhealthy"
    );
    if (failing.length > 0) {
      dependencyHealthCronLogger.warn("dependency_health", {
        event: "dependency_health",
        status,
        failing_dependencies: failing.map(item => ({
          name: item.name,
          status: item.status,
          reason: item.reason || null,
          latencyMs: item.latencyMs ?? null,
        })),
        checked_at: snapshot.checkedAt,
      });
    }

    const statusCode = status === "unhealthy" ? 503 : 200;

    return NextResponse.json(
      {
        ok: status !== "unhealthy",
        status,
        checkedAt: snapshot.checkedAt,
        failingDependencies: failing.map(item => ({
          name: item.name,
          status: item.status,
          reason: item.reason || null,
          latencyMs: item.latencyMs ?? null,
        })),
        dependencies,
      },
      { status: statusCode }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
