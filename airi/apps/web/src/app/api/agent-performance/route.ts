import connectDB from "@/lib/mongoose";
import {
  getMembershipDisplayName,
  getUserProfilesByIds,
} from "@/lib/supabase/company-users";
import { createClient } from "@/lib/supabase/server";
import { Conversation } from "@/models/conversation";
import type {
  AgentPerformance,
  AgentPerformanceResponse,
  AgentScoreBreakdown,
  CoachingPriority,
  DimensionHealth,
  QaDimensionKey,
  TrendDirection,
} from "@/types/performance";
import { NextResponse } from "next/server";

export interface AgentData {
  user_id: string | null;
  email: string | null;
}

interface AgentPeriodPerformance {
  _id: string;
  avg_empathy: number | null;
  avg_clarity: number | null;
  avg_script_adherence: number | null;
  avg_resolution: number | null;
  avg_response_time_sec: number | null;
  avg_csat: number | null;
  rated_conversation_count: number;
  low_qa_conversation_count: number;
  conversation_count: number;
}

interface AgentCoverageData {
  _id: string;
  total_conversation_count: number;
}

type NullableNumber = number | null | undefined;

const DIMENSION_KEYS: QaDimensionKey[] = [
  "empathy",
  "clarity",
  "scriptAdherence",
  "resolution",
];

const DIMENSION_LABELS: Record<QaDimensionKey, string> = {
  empathy: "Empathy",
  clarity: "Clarity",
  scriptAdherence: "Script adherence",
  resolution: "Resolution",
};

function toDateRangeMatch(startDate?: Date, endDate?: Date) {
  if (!startDate && !endDate) return undefined;

  const createdAt: Record<string, Date> = {};
  if (startDate) createdAt.$gte = startDate;
  if (endDate) createdAt.$lt = endDate;

  return createdAt;
}

function safeRound(value: NullableNumber, digits = 1): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function averageNumbers(values: NullableNumber[]): number | null {
  const filtered = values.filter(
    (value): value is number =>
      value !== null && value !== undefined && Number.isFinite(value)
  );

  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function weightedAverage<T>(
  rows: T[],
  getValue: (row: T) => NullableNumber,
  getWeight: (row: T) => number
): number | null {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const value = getValue(row);
    const weight = getWeight(row);
    if (
      value === null ||
      value === undefined ||
      Number.isNaN(value) ||
      weight <= 0
    ) {
      continue;
    }

    weightedSum += value * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

function getTrendDirection(trend: NullableNumber): TrendDirection {
  if (trend === null || trend === undefined) return null;
  if (trend > 0) return "up";
  if (trend < 0) return "down";
  return "stable";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;

  if (error && typeof error === "object") {
    const details = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    const parts = [
      details.message,
      details.details,
      details.hint,
      details.code,
    ].filter((value): value is string => typeof value === "string" && !!value);

    if (parts.length > 0) return parts.join(" ");
  }

  return "Unknown error";
}

function getOverallQaScore(periodData?: AgentPeriodPerformance): number | null {
  if (!periodData) return null;

  return averageNumbers([
    periodData.avg_empathy,
    periodData.avg_clarity,
    periodData.avg_script_adherence,
    periodData.avg_resolution,
  ]);
}

function getDimensionFromPeriod(
  periodData: AgentPeriodPerformance,
  key: QaDimensionKey
): NullableNumber {
  switch (key) {
    case "empathy":
      return periodData.avg_empathy;
    case "clarity":
      return periodData.avg_clarity;
    case "scriptAdherence":
      return periodData.avg_script_adherence;
    case "resolution":
      return periodData.avg_resolution;
    default:
      return null;
  }
}

function getDimensionFromScores(
  scores: AgentScoreBreakdown,
  key: QaDimensionKey
): number {
  switch (key) {
    case "empathy":
      return scores.empathy;
    case "clarity":
      return scores.clarity;
    case "scriptAdherence":
      return scores.scriptAdherence;
    case "resolution":
      return scores.resolution;
    default:
      return 0;
  }
}

function createEmptyResponse(days: number): AgentPerformanceResponse {
  return {
    agents: [],
    summary: {
      days,
      active_managers: 0,
      total_scored_conversations: 0,
      total_handled_conversations: 0,
      avg_qa_score: 0,
      qa_score_trend: null,
      qa_coverage_rate: null,
      avg_response_time_sec: null,
      avg_csat: null,
      managers_needing_attention: 0,
      improving_managers: 0,
      declining_managers: 0,
    },
    dimensions: [],
    coaching_priorities: [],
  };
}

async function getPeriodPerformance(
  workspaceId: string,
  agentIds: string[],
  startDate?: Date,
  endDate?: Date
): Promise<AgentPeriodPerformance[]> {
  const createdAt = toDateRangeMatch(startDate, endDate);
  const matchQuery: Record<string, unknown> = {
    workspaceId,
    handled_by_agent_id: { $in: agentIds },
    agent_performance_scorecard: { $ne: null },
    ...(createdAt ? { createdAt } : {}),
  };

  return Conversation.aggregate<AgentPeriodPerformance>([
    { $match: matchQuery },
    {
      $addFields: {
        conversation_qa_score: {
          $avg: [
            "$agent_performance_scorecard.empathy_score",
            "$agent_performance_scorecard.clarity_score",
            "$agent_performance_scorecard.script_adherence_score",
            "$agent_performance_scorecard.resolution_efficiency_score",
          ],
        },
      },
    },
    {
      $group: {
        _id: "$handled_by_agent_id",
        avg_empathy: { $avg: "$agent_performance_scorecard.empathy_score" },
        avg_clarity: { $avg: "$agent_performance_scorecard.clarity_score" },
        avg_script_adherence: {
          $avg: "$agent_performance_scorecard.script_adherence_score",
        },
        avg_resolution: {
          $avg: "$agent_performance_scorecard.resolution_efficiency_score",
        },
        avg_response_time_sec: {
          $avg: "$interaction_metrics.agent_response_time_avg_sec",
        },
        avg_csat: { $avg: "$customer_satisfaction_score" },
        rated_conversation_count: {
          $sum: {
            $cond: [{ $ne: ["$customer_satisfaction_score", null] }, 1, 0],
          },
        },
        low_qa_conversation_count: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ["$conversation_qa_score", null] },
                  { $lt: ["$conversation_qa_score", 7] },
                ],
              },
              1,
              0,
            ],
          },
        },
        conversation_count: { $sum: 1 },
      },
    },
  ]);
}

async function getCoverageByAgent(
  workspaceId: string,
  agentIds: string[],
  startDate?: Date,
  endDate?: Date
): Promise<AgentCoverageData[]> {
  const createdAt = toDateRangeMatch(startDate, endDate);
  const matchQuery: Record<string, unknown> = {
    workspaceId,
    handled_by_agent_id: { $in: agentIds },
    ...(createdAt ? { createdAt } : {}),
  };

  return Conversation.aggregate<AgentCoverageData>([
    { $match: matchQuery },
    {
      $group: {
        _id: "$handled_by_agent_id",
        total_conversation_count: { $sum: 1 },
      },
    },
  ]);
}

export async function GET(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId");
  const daysParam = searchParams.get("days"); // e.g., 7, 30, 90

  if (!workspaceId) {
    return new Response(JSON.stringify({ error: "workspaceId is required" }), {
      status: 400,
    });
  }

  // Verify user has access to this workspace
  const { data: access, error: accessError } = await supabase
    .from("company_users")
    .select("workspace_id")
    .eq("user_id", user.id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (accessError) {
    console.error("[AgentPerformance] Failed to verify workspace access", {
      workspaceId,
      error: getErrorMessage(accessError),
    });

    return NextResponse.json(
      { error: "Failed to verify workspace access" },
      { status: 500 }
    );
  }

  if (!access) {
    return new Response(
      JSON.stringify({ error: "Access denied to this workspace" }),
      { status: 403 }
    );
  }

  try {
    await connectDB();

    // Get managers for this workspace only
    const { data: agents, error: agentsError } = await supabase
      .from("company_users")
      .select("user_id, email")
      .eq("workspace_id", workspaceId);

    if (agentsError) throw agentsError;

    const daysRaw = daysParam ? Number.parseInt(daysParam, 10) : 30;
    const days =
      Number.isFinite(daysRaw) && daysRaw > 0
        ? Math.min(Math.max(daysRaw, 1), 365)
        : 30;

    const agentRows = ((agents ?? []) as AgentData[]).filter(
      agent => typeof agent.user_id === "string" && agent.user_id.trim() !== ""
    );

    if (agentRows.length === 0) {
      return NextResponse.json(createEmptyResponse(days));
    }

    const agentIds = agentRows.map(agent => agent.user_id as string);
    const profilesById = await getUserProfilesByIds(supabase, agentIds);

    // Calculate date ranges
    const now = new Date();
    const currentPeriodStart = new Date(
      now.getTime() - days * 24 * 60 * 60 * 1000
    );
    const previousPeriodStart = new Date(
      currentPeriodStart.getTime() - days * 24 * 60 * 60 * 1000
    );

    // Fetch all data in parallel
    const [currentData, previousData, coverageData] = await Promise.all([
      getPeriodPerformance(workspaceId, agentIds, currentPeriodStart, now),
      getPeriodPerformance(
        workspaceId,
        agentIds,
        previousPeriodStart,
        currentPeriodStart
      ),
      getCoverageByAgent(workspaceId, agentIds, currentPeriodStart, now),
    ]);

    const currentByAgent = new Map(currentData.map(item => [item._id, item]));
    const previousByAgent = new Map(previousData.map(item => [item._id, item]));
    const coverageByAgent = new Map(coverageData.map(item => [item._id, item]));

    const leaderboard: AgentPerformance[] = agentRows
      .map(agent => {
        const agentId = agent.user_id as string;
        const current = currentByAgent.get(agentId);
        const previous = previousByAgent.get(agentId);
        const coverage = coverageByAgent.get(agentId);

        const currentOverall = getOverallQaScore(current);
        const previousOverall = getOverallQaScore(previous);
        const trend =
          currentOverall !== null && previousOverall !== null
            ? safeRound(currentOverall - previousOverall, 1)
            : null;

        const scores: AgentScoreBreakdown | null = current
          ? {
              empathy: safeRound(current.avg_empathy, 1) ?? 0,
              clarity: safeRound(current.avg_clarity, 1) ?? 0,
              scriptAdherence: safeRound(current.avg_script_adherence, 1) ?? 0,
              resolution: safeRound(current.avg_resolution, 1) ?? 0,
            }
          : null;

        const conversationCount = current?.conversation_count ?? 0;
        const totalConversationCount = Math.max(
          coverage?.total_conversation_count ?? 0,
          conversationCount
        );
        const qaCoverageRate =
          totalConversationCount > 0
            ? safeRound((conversationCount / totalConversationCount) * 100, 1)
            : null;
        const identity = profilesById.get(agentId) ?? null;

        return {
          id: agentId,
          name: getMembershipDisplayName(
            {
              email: agent.email,
              users: identity,
            },
            "Unknown Manager"
          ),
          avatar_url: identity?.avatar_url || null,
          conversation_count: conversationCount,
          total_conversation_count: totalConversationCount,
          qa_coverage_rate: qaCoverageRate,
          low_qa_conversation_count: current?.low_qa_conversation_count ?? 0,
          overall_qa_score: safeRound(currentOverall, 1) ?? 0,
          scores,
          trend,
          trend_direction: getTrendDirection(trend),
          avg_response_time_sec: safeRound(current?.avg_response_time_sec, 0),
          avg_csat: safeRound(current?.avg_csat, 1),
        };
      })
      .filter(agent => agent.conversation_count > 0)
      .sort(
        (a, b) =>
          b.overall_qa_score - a.overall_qa_score ||
          b.conversation_count - a.conversation_count
      );

    if (leaderboard.length === 0) {
      return NextResponse.json(createEmptyResponse(days));
    }

    const currentTeamQa = weightedAverage(
      currentData,
      row => getOverallQaScore(row),
      row => row.conversation_count
    );
    const previousTeamQa = weightedAverage(
      previousData,
      row => getOverallQaScore(row),
      row => row.conversation_count
    );

    const totalScoredConversations = leaderboard.reduce(
      (sum, agent) => sum + agent.conversation_count,
      0
    );
    const totalHandledConversations = leaderboard.reduce(
      (sum, agent) => sum + agent.total_conversation_count,
      0
    );

    const dimensions: DimensionHealth[] = DIMENSION_KEYS.map(key => {
      const average = weightedAverage(
        currentData,
        row => getDimensionFromPeriod(row, key),
        row => row.conversation_count
      );
      const previousAverage = weightedAverage(
        previousData,
        row => getDimensionFromPeriod(row, key),
        row => row.conversation_count
      );

      const ranked = leaderboard
        .filter(agent => agent.scores !== null)
        .map(agent => ({
          id: agent.id,
          name: agent.name,
          score: getDimensionFromScores(
            agent.scores as AgentScoreBreakdown,
            key
          ),
        }))
        .sort((a, b) => b.score - a.score);

      const strongest = ranked.length > 0 ? ranked[0] : null;
      const weakest = ranked.length > 0 ? ranked[ranked.length - 1] : null;

      return {
        key,
        label: DIMENSION_LABELS[key],
        average: safeRound(average, 1) ?? 0,
        trend:
          average !== null && previousAverage !== null
            ? safeRound(average - previousAverage, 1)
            : null,
        strongest_manager: strongest
          ? {
              id: strongest.id,
              name: strongest.name,
              score: safeRound(strongest.score, 1) ?? 0,
            }
          : null,
        weakest_manager: weakest
          ? {
              id: weakest.id,
              name: weakest.name,
              score: safeRound(weakest.score, 1) ?? 0,
            }
          : null,
      };
    });

    const coaching_priorities: CoachingPriority[] = leaderboard
      .filter(agent => agent.scores !== null)
      .map(agent => {
        const scores = agent.scores as AgentScoreBreakdown;
        const focusCandidate = DIMENSION_KEYS.map(key => ({
          key,
          score: getDimensionFromScores(scores, key),
        })).sort((a, b) => a.score - b.score)[0];

        const riskScore =
          Math.max(0, 7.5 - agent.overall_qa_score) * 1.4 +
          Math.max(0, -(agent.trend ?? 0)) * 1.8 +
          Math.min(2, agent.conversation_count / 12);

        return {
          id: agent.id,
          name: agent.name,
          avatar_url: agent.avatar_url,
          overall_qa_score: agent.overall_qa_score,
          trend: agent.trend ?? null,
          conversation_count: agent.conversation_count,
          focus_area: focusCandidate.key,
          focus_score: safeRound(focusCandidate.score, 1) ?? 0,
          risk_score: safeRound(riskScore, 2) ?? 0,
        };
      })
      .filter(item => item.risk_score >= 0.8)
      .sort(
        (a, b) =>
          b.risk_score - a.risk_score ||
          b.conversation_count - a.conversation_count
      )
      .slice(0, 5);

    if (coaching_priorities.length === 0) {
      coaching_priorities.push(
        ...leaderboard
          .slice()
          .sort((a, b) => a.overall_qa_score - b.overall_qa_score)
          .slice(0, Math.min(3, leaderboard.length))
          .map(agent => {
            const scores = agent.scores as AgentScoreBreakdown;
            const focusCandidate = DIMENSION_KEYS.map(key => ({
              key,
              score: getDimensionFromScores(scores, key),
            })).sort((a, b) => a.score - b.score)[0];

            return {
              id: agent.id,
              name: agent.name,
              avatar_url: agent.avatar_url,
              overall_qa_score: agent.overall_qa_score,
              trend: agent.trend ?? null,
              conversation_count: agent.conversation_count,
              focus_area: focusCandidate.key,
              focus_score: safeRound(focusCandidate.score, 1) ?? 0,
              risk_score: 0.5,
            };
          })
      );
    }

    const response: AgentPerformanceResponse = {
      agents: leaderboard,
      summary: {
        days,
        active_managers: leaderboard.length,
        total_scored_conversations: totalScoredConversations,
        total_handled_conversations: totalHandledConversations,
        avg_qa_score: safeRound(currentTeamQa, 1) ?? 0,
        qa_score_trend:
          currentTeamQa !== null && previousTeamQa !== null
            ? safeRound(currentTeamQa - previousTeamQa, 1)
            : null,
        qa_coverage_rate:
          totalHandledConversations > 0
            ? safeRound(
                (totalScoredConversations / totalHandledConversations) * 100,
                1
              )
            : null,
        avg_response_time_sec: safeRound(
          weightedAverage(
            currentData,
            row => row.avg_response_time_sec,
            row => row.conversation_count
          ),
          0
        ),
        avg_csat: safeRound(
          weightedAverage(
            currentData,
            row => row.avg_csat,
            row => row.rated_conversation_count
          ),
          1
        ),
        managers_needing_attention: leaderboard.filter(
          agent => agent.overall_qa_score < 7 || (agent.trend ?? 0) < -0.5
        ).length,
        improving_managers: leaderboard.filter(agent => (agent.trend ?? 0) > 0)
          .length,
        declining_managers: leaderboard.filter(agent => (agent.trend ?? 0) < 0)
          .length,
      },
      dimensions,
      coaching_priorities,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[AgentPerformance] Failed to load performance data", {
      workspaceId,
      error: getErrorMessage(error),
    });

    return NextResponse.json(
      { error: "Failed to load performance data" },
      { status: 500 }
    );
  }
}
