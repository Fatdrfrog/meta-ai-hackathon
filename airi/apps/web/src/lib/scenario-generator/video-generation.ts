import type { ScenarioGeneratedRecipientCohort } from "@icecore/scenario-contracts";

export type ScenarioVideoGenerationPlan = {
  branchId: string;
  branchLabel: string;
  variantIndex: number;
  prompt: string;
  fileName: string;
};

type ScenarioVideoPlanCohort = Pick<
  ScenarioGeneratedRecipientCohort,
  "id" | "label" | "count"
>;

type BuildScenarioVideoGenerationPlansInput = {
  prompt: string;
  campaignName: string;
  cohorts: ScenarioVideoPlanCohort[];
  minVideos?: number;
  maxVideos?: number;
};

function sanitizeFilePart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "video"
  );
}

function normalizeCohorts(
  cohorts: ScenarioVideoPlanCohort[]
): ScenarioVideoPlanCohort[] {
  const normalized = cohorts
    .map((cohort, index) => ({
      id: cohort.id?.trim() || `branch-${index + 1}`,
      label: cohort.label?.trim() || `Audience ${index + 1}`,
      count: Math.max(0, Math.floor(cohort.count || 0)),
    }))
    .slice(0, 10);

  return normalized.length > 0
    ? normalized
    : [{ id: "default", label: "Default audience", count: 0 }];
}

function buildVideoPrompt(params: {
  prompt: string;
  campaignName: string;
  cohort: ScenarioVideoPlanCohort;
  variantIndex: number;
}): string {
  return [
    `Create a short TikTok-style engagement video for "${params.campaignName}".`,
    `Audience branch: ${params.cohort.label} (${params.cohort.count} recipients).`,
    `Goal and context: ${params.prompt}`,
    "Format: vertical 9:16, 6 seconds, mobile-first, direct response campaign creative.",
    "Use clear visual storytelling, product/service context, and a CTA that matches the campaign goal.",
    params.variantIndex > 1
      ? `Variant ${params.variantIndex}: use a distinct hook and pacing from earlier variants for this same audience.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildScenarioVideoGenerationPlans(
  input: BuildScenarioVideoGenerationPlansInput
): ScenarioVideoGenerationPlan[] {
  const cohorts = normalizeCohorts(input.cohorts);
  const minVideos = Math.max(1, input.minVideos ?? 3);
  const maxVideos = Math.max(minVideos, Math.min(10, input.maxVideos ?? 10));
  const total = Math.min(maxVideos, Math.max(minVideos, cohorts.length));
  const variantCountByBranch = new Map<string, number>();
  const plans: ScenarioVideoGenerationPlan[] = [];

  for (let index = 0; index < total; index += 1) {
    const cohort = cohorts[index % cohorts.length];
    const variantIndex = (variantCountByBranch.get(cohort.id) || 0) + 1;
    variantCountByBranch.set(cohort.id, variantIndex);
    plans.push({
      branchId: cohort.id,
      branchLabel: cohort.label,
      variantIndex,
      prompt: buildVideoPrompt({
        prompt: input.prompt,
        campaignName: input.campaignName,
        cohort,
        variantIndex,
      }),
      fileName: `${sanitizeFilePart(input.campaignName)}-${sanitizeFilePart(cohort.id)}-v${variantIndex}.mp4`,
    });
  }

  return plans;
}
