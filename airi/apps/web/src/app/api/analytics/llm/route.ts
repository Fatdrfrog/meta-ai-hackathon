import { queryAiriReplyOperatorAnalytics } from "@/app/actions/posthog-queries";
import {
  canCallGcpAIGateway,
  queryRemoteLlmAnalytics,
} from "@/lib/ai/gcp-ai-gateway";
import { LLM_PRICING_VERSION } from "@icecore/airi-runtime/llm-pricing";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { checkUserWorkspaceAccess } from "@/lib/supabase/queries";
import { requiredFieldResponse } from "@/lib/api/json-body";

function parseDaysParam(rawValue: string | null): number {
  const parsed = rawValue ? Number.parseInt(rawValue, 10) : 30;
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 30;
  return Math.min(Math.max(parsed, 1), 365);
}

function isWarehouseReadEnabled(): boolean {
  const raw = String(
    process.env.LLM_ANALYTICS_WAREHOUSE_READ_ENABLED || ""
  ).toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return canCallGcpAIGateway();
}

function readFulfilledRows(
  result:
    | PromiseSettledResult<Awaited<ReturnType<typeof queryRemoteLlmAnalytics>>>
    | undefined
): Array<Record<string, unknown>> {
  return result?.status === "fulfilled" ? result.value.rows : [];
}

function readFulfilledOverview(
  result:
    | PromiseSettledResult<Awaited<ReturnType<typeof queryRemoteLlmAnalytics>>>
    | undefined
): Record<string, unknown> | null {
  return result?.status === "fulfilled" ? result.value.rows[0] || null : null;
}

function warehouseErrorMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error
    ? result.reason.message
    : String(result.reason);
}

function isExpectedWarehouseAuthError(message: string): boolean {
  return (
    /GCP AI gateway HTTP (401|403)/i.test(message) &&
    /(bearer token|unauthorized|forbidden|oidc|auth)/i.test(message)
  );
}

type WarehouseQueryResult = Awaited<ReturnType<typeof queryRemoteLlmAnalytics>>;
type WarehouseQueryKey =
  | "overview"
  | "modelBreakdown"
  | "ragFailures"
  | "scoreTrends"
  | "generationQuality"
  | "systemPerformance"
  | "operationalEfficiency"
  | "spendOverview"
  | "spendDaily"
  | "spendByOperation"
  | "airiChatOverview"
  | "airiChatDaily"
  | "airiChatIssues"
  | "airiChatQualityScore"
  | "companySpendOverview";
type WarehouseQueryEntry = [WarehouseQueryKey, Promise<WarehouseQueryResult>];
type WarehouseSettledResults = Partial<
  Record<WarehouseQueryKey, PromiseSettledResult<WarehouseQueryResult>>
>;

async function resolveCompanyWorkspaceIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workspaceId: string
): Promise<string[] | null> {
  const { data: workspaceRow } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();

  const companyId = workspaceRow?.company_id;
  if (!companyId) return null;

  const { data: siblings } = await supabase
    .from("workspaces")
    .select("id")
    .eq("company_id", companyId);

  const workspaceIds = (siblings || [])
    .map(row => String(row.id || "").trim())
    .filter(Boolean);

  return workspaceIds.length > 1 ? workspaceIds : null;
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId");
    if (!workspaceId) return requiredFieldResponse("workspaceId");

    if (!(await checkUserWorkspaceAccess(supabase, user.id, workspaceId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const days = parseDaysParam(searchParams.get("days"));
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    const warehouseEnabled = isWarehouseReadEnabled();
    const companyWorkspaceIds = warehouseEnabled
      ? await resolveCompanyWorkspaceIds(supabase, workspaceId)
      : null;

    const warehouseQueryEntries: WarehouseQueryEntry[] | null = warehouseEnabled
      ? [
          [
            "overview",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "quality_overview",
              days,
              limit: 1,
            }),
          ],
          [
            "modelBreakdown",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "model_breakdown",
              days,
              limit: 8,
            }),
          ],
          [
            "ragFailures",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "rag_failures",
              days,
              limit: 8,
            }),
          ],
          [
            "scoreTrends",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "score_trends",
              days,
              limit: 100,
            }),
          ],
          [
            "generationQuality",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "generation_quality",
              days,
              limit: 1,
            }),
          ],
          [
            "systemPerformance",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "system_performance",
              days,
              limit: 1,
            }),
          ],
          [
            "operationalEfficiency",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "operational_efficiency",
              days,
              limit: 1,
            }),
          ],
          [
            "spendOverview",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "spend_overview",
              days,
              limit: 1,
            }),
          ],
          [
            "spendDaily",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "spend_daily",
              days,
              limit: 90,
            }),
          ],
          [
            "spendByOperation",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "spend_by_operation",
              days,
              limit: 12,
            }),
          ],
          [
            "airiChatOverview",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "airi_chat_overview",
              days,
              limit: 1,
            }),
          ],
          [
            "airiChatDaily",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "airi_chat_daily",
              days,
              limit: 90,
            }),
          ],
          [
            "airiChatIssues",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "airi_chat_issues",
              days,
              limit: 8,
            }),
          ],
          [
            "airiChatQualityScore",
            queryRemoteLlmAnalytics({
              workspaceId,
              query: "airi_chat_quality_score",
              days,
              limit: 1,
            }),
          ],
          ...(companyWorkspaceIds
            ? [
                [
                  "companySpendOverview",
                  queryRemoteLlmAnalytics({
                    workspaceId,
                    workspaceIds: companyWorkspaceIds,
                    query: "spend_overview",
                    days,
                    limit: 1,
                  }),
                ] satisfies WarehouseQueryEntry,
              ]
            : []),
        ]
      : null;

    const [analytics, warehouseSettledResults] = await Promise.all([
      queryAiriReplyOperatorAnalytics(workspaceId, {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      }),
      warehouseQueryEntries
        ? Promise.allSettled(
            warehouseQueryEntries.map(([, promise]) => promise)
          )
        : Promise.resolve(null),
    ]);
    const warehouseResults: WarehouseSettledResults | null =
      warehouseQueryEntries && warehouseSettledResults
        ? Object.fromEntries(
            warehouseQueryEntries.map(([key], index) => [
              key,
              warehouseSettledResults[index],
            ])
          )
        : null;

    const fulfilledWarehouseResult =
      Object.values(warehouseResults || {}).find(
        (
          result
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof queryRemoteLlmAnalytics>>
        > => result.status === "fulfilled"
      ) || null;

    const warehouse =
      warehouseResults === null
        ? null
        : {
            overview: readFulfilledOverview(warehouseResults.overview),
            modelBreakdown: readFulfilledRows(warehouseResults.modelBreakdown),
            ragFailures: readFulfilledRows(warehouseResults.ragFailures),
            scoreTrends: readFulfilledRows(warehouseResults.scoreTrends),
            generationQuality: readFulfilledOverview(
              warehouseResults.generationQuality
            ),
            systemPerformance: readFulfilledOverview(
              warehouseResults.systemPerformance
            ),
            operationalEfficiency: readFulfilledOverview(
              warehouseResults.operationalEfficiency
            ),
            spend: {
              workspace: {
                overview: readFulfilledOverview(warehouseResults.spendOverview),
                daily: readFulfilledRows(warehouseResults.spendDaily),
                byOperation: readFulfilledRows(
                  warehouseResults.spendByOperation
                ),
              },
              company: companyWorkspaceIds
                ? {
                    overview: readFulfilledOverview(
                      warehouseResults.companySpendOverview
                    ),
                    workspaceCount: companyWorkspaceIds.length,
                  }
                : null,
              pricingVersion: LLM_PRICING_VERSION,
            },
            airiChats: {
              overview: readFulfilledOverview(
                warehouseResults.airiChatOverview
              ),
              daily: readFulfilledRows(warehouseResults.airiChatDaily),
              issues: readFulfilledRows(warehouseResults.airiChatIssues),

              qualityScore: readFulfilledOverview(
                warehouseResults.airiChatQualityScore
              ),
            },
            source: Object.values(warehouseResults).find(
              result =>
                result.status === "fulfilled" &&
                result.value.source === "bigquery"
            )
              ? "bigquery"
              : "disabled",
            generatedAt:
              fulfilledWarehouseResult?.value.generatedAt ||
              new Date().toISOString(),
            errors: Object.values(warehouseResults)
              .filter(
                (result): result is PromiseRejectedResult =>
                  result.status === "rejected"
              )
              .map(warehouseErrorMessage)
              .filter(message => !isExpectedWarehouseAuthError(message)),
          };

    return NextResponse.json({
      days,
      analytics,
      warehouse,
    });
  } catch (error) {
    console.error("[LLM Analytics API] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load LLM analytics" },
      { status: 500 }
    );
  }
}
