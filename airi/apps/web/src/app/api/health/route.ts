import {
  type DependencyAggregateStatus,
  collectDependencyHealth,
} from "@/lib/dependency-health";
import { getDBHealth, getDBState } from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  services: {
    mongodb: {
      status: string;
      latency?: number;
      connectionState: string;
    };
    supabase: {
      status: string;
      latency?: number;
    };
    dependencies: Record<
      string,
      {
        status: string;
        latencyMs?: number;
        reason?: string;
        details?: Record<string, string | number | boolean | null>;
      }
    >;
  };
  checks: {
    core: "healthy" | "degraded" | "unhealthy";
    dependencies: DependencyAggregateStatus;
  };
  environment: string;
  uptime: number;
}

function getCoreStatus(params: {
  mongoStatus: string;
  mongoLatency?: number;
  supabaseStatus: string;
  supabaseLatency?: number;
}): "healthy" | "degraded" | "unhealthy" {
  if (
    params.mongoStatus === "unhealthy" ||
    params.supabaseStatus === "unhealthy"
  ) {
    return "unhealthy";
  }

  if (
    params.mongoStatus !== "healthy" ||
    params.supabaseStatus !== "healthy" ||
    (params.mongoLatency && params.mongoLatency > 1000) ||
    (params.supabaseLatency && params.supabaseLatency > 2000)
  ) {
    return "degraded";
  }

  return "healthy";
}

function combineOverallStatus(params: {
  coreStatus: "healthy" | "degraded" | "unhealthy";
  dependencyStatus: DependencyAggregateStatus;
}): "healthy" | "degraded" | "unhealthy" {
  if (params.coreStatus === "unhealthy") {
    return "unhealthy";
  }

  if (
    params.coreStatus === "degraded" ||
    params.dependencyStatus === "degraded" ||
    params.dependencyStatus === "unhealthy"
  ) {
    return "degraded";
  }

  return "healthy";
}

export async function GET(): Promise<NextResponse<HealthStatus>> {
  try {
    const [mongoHealth, dependencyHealth] = await Promise.all([
      getDBHealth(),
      collectDependencyHealth(),
    ]);
    const mongoState = getDBState();

    let supabaseHealth: { status: string; latency?: number } = {
      status: "unknown",
    };

    try {
      // Health checks have no user session, and anon cannot read companies.
      const supabaseStart = Date.now();
      const { error } = await supabaseAdmin
        .from("companies")
        .select("id")
        .limit(1);
      const supabaseLatency = Date.now() - supabaseStart;

      supabaseHealth = {
        status: error ? "unhealthy" : "healthy",
        latency: supabaseLatency,
      };
    } catch {
      supabaseHealth = { status: "unhealthy" };
    }

    const coreStatus = getCoreStatus({
      mongoStatus: mongoHealth.status,
      mongoLatency: mongoHealth.latency,
      supabaseStatus: supabaseHealth.status,
      supabaseLatency: supabaseHealth.latency,
    });

    const overallStatus = combineOverallStatus({
      coreStatus,
      dependencyStatus: dependencyHealth.status,
    });

    const healthStatus: HealthStatus = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services: {
        mongodb: {
          status: mongoHealth.status,
          latency: mongoHealth.latency,
          connectionState: mongoState,
        },
        supabase: {
          status: supabaseHealth.status,
          latency: supabaseHealth.latency,
        },
        dependencies: dependencyHealth.dependencies,
      },
      checks: {
        core: coreStatus,
        dependencies: dependencyHealth.status,
      },
      environment: process.env.NODE_ENV || "development",
      uptime: process.uptime(),
    };

    const statusCode = overallStatus === "unhealthy" ? 503 : 200;
    return NextResponse.json(healthStatus, { status: statusCode });
  } catch {
    const healthStatus: HealthStatus = {
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      services: {
        mongodb: {
          status: "error",
          connectionState: "unknown",
        },
        supabase: {
          status: "error",
        },
        dependencies: {},
      },
      checks: {
        core: "unhealthy",
        dependencies: "unhealthy",
      },
      environment: process.env.NODE_ENV || "development",
      uptime: process.uptime(),
    };

    return NextResponse.json(healthStatus, { status: 503 });
  }
}
