export type QaDimensionKey =
  | "empathy"
  | "clarity"
  | "scriptAdherence"
  | "resolution";

export type TrendDirection = "up" | "down" | "stable" | null;

export interface AgentScoreBreakdown {
  empathy: number;
  clarity: number;
  scriptAdherence: number;
  resolution: number;
}

export interface AgentPerformance {
  id: string | number;
  name: string;
  avatar_url?: string | null;
  conversation_count: number;
  total_conversation_count: number;
  qa_coverage_rate: number | null;
  low_qa_conversation_count: number;
  overall_qa_score: number;
  scores: AgentScoreBreakdown | null;
  trend?: number | null;
  trend_direction?: TrendDirection;
  avg_response_time_sec: number | null;
  avg_csat: number | null;
}

export interface TeamPerformanceSummary {
  days: number;
  active_managers: number;
  total_scored_conversations: number;
  total_handled_conversations: number;
  avg_qa_score: number;
  qa_score_trend: number | null;
  qa_coverage_rate: number | null;
  avg_response_time_sec: number | null;
  avg_csat: number | null;
  managers_needing_attention: number;
  improving_managers: number;
  declining_managers: number;
}

export interface DimensionManagerReference {
  id: string | number;
  name: string;
  score: number;
}

export interface DimensionHealth {
  key: QaDimensionKey;
  label: string;
  average: number;
  trend: number | null;
  strongest_manager: DimensionManagerReference | null;
  weakest_manager: DimensionManagerReference | null;
}

export interface CoachingPriority {
  id: string | number;
  name: string;
  avatar_url?: string | null;
  overall_qa_score: number;
  trend: number | null;
  conversation_count: number;
  focus_area: QaDimensionKey;
  focus_score: number;
  risk_score: number;
}

export interface AgentPerformanceResponse {
  agents: AgentPerformance[];
  summary: TeamPerformanceSummary;
  dimensions: DimensionHealth[];
  coaching_priorities: CoachingPriority[];
}
