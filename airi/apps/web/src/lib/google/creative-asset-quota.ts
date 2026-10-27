import "server-only";

import { getGoogleFreeGenerationLimit } from "@/lib/google/creative-assets";
import { getWorkspacePlatformCreativeGenerationUsage } from "@/lib/creative-assets/platform-creative-generation-quota-ledger";
import { isPlatformElevenLabsConfigured } from "@/lib/elevenlabs/elevenlabs-source";

export type GoogleCreativeGenerationQuota = {
  configured: boolean;
  limit: number;
  used: number;
  remaining: number;
};

export type WorkspaceCreativeGenerationQuotas = {
  google: GoogleCreativeGenerationQuota;
  platform: GoogleCreativeGenerationQuota;
};

async function getWorkspaceCreativeGenerationUsage(
  workspaceId: string,
  limit: number
): Promise<number> {
  return getWorkspacePlatformCreativeGenerationUsage(workspaceId, limit);
}

export async function getWorkspaceCreativeGenerationQuotas(
  workspaceId: string
): Promise<WorkspaceCreativeGenerationQuotas> {
  const limit = getGoogleFreeGenerationLimit();
  const used = await getWorkspaceCreativeGenerationUsage(workspaceId, limit);
  const remaining = Math.max(0, limit - used);
  const googleConfigured = false;

  return {
    google: {
      configured: googleConfigured,
      limit,
      used,
      remaining,
    },
    platform: {
      configured: isPlatformElevenLabsConfigured(),
      limit,
      used,
      remaining,
    },
  };
}

export async function getWorkspacePlatformCreativeGenerationQuota(
  workspaceId: string
): Promise<GoogleCreativeGenerationQuota> {
  return (await getWorkspaceCreativeGenerationQuotas(workspaceId)).platform;
}

export function canUsePlatformFreeCreativeGeneration(
  quota: GoogleCreativeGenerationQuota
): boolean {
  return quota.configured && quota.remaining > 0;
}
