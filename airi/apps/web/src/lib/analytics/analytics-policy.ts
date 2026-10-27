import { z } from "zod";
import { normalizeCrmStageKey } from "@/lib/crm/stages";
import { AnalyticsPolicy } from "@/models/analytics-policy";

export { AnalyticsPolicy } from "@/models/analytics-policy";
export const analyticsPolicyInput = z
  .object({
    revision: z.number().int().min(0),
    qualifiedStageKeys: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .refine(
            key => normalizeCrmStageKey(key) === key,
            "Use a canonical CRM stage key"
          )
      )
      .min(1)
      .max(20),
  })
  .strict();
export async function getAnalyticsPolicy(
  workspaceId: string
): Promise<{ qualifiedStageKeys: string[]; revision: number }> {
  const policy = await AnalyticsPolicy.findOne({ workspaceId }).lean<{
    qualifiedStageKeys: string[];
    revision: number;
  } | null>();
  return policy
    ? {
        qualifiedStageKeys: policy.qualifiedStageKeys,
        revision: policy.revision,
      }
    : { qualifiedStageKeys: ["qualified"], revision: 0 };
}
