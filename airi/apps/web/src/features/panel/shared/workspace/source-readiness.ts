import "server-only";

import { isConfiguredIntegrationSource } from "@/lib/integrations/source-status";
import { logger } from "@/lib/logger";
import type { Source } from "@icecore/shared/types/sources";

type SourceReadinessQueryClient = {
  from: (table: "sources") => {
    select: (columns: string) => {
      eq: (
        column: "workspace_id",
        value: string
      ) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
  };
};

export type WorkspaceSourceReadiness = {
  configuredSources: Array<
    Pick<Source, "id" | "type" | "name" | "credentials">
  >;
  configuredSourceTypes: string[];
  hasConfiguredSources: boolean;
  hasWhatsApp: boolean;
  loadError: boolean;
};

function sourceReadinessLoadError(): WorkspaceSourceReadiness {
  return {
    configuredSources: [],
    configuredSourceTypes: [],
    hasConfiguredSources: false,
    hasWhatsApp: false,
    loadError: true,
  };
}

export async function getWorkspaceSourceReadiness(
  supabase: unknown,
  workspaceId: string
): Promise<WorkspaceSourceReadiness> {
  const queryClient = supabase as SourceReadinessQueryClient;
  let data: unknown[] | null;
  let error: unknown;

  try {
    const result = await queryClient
      .from("sources")
      .select("id, type, name, credentials")
      .eq("workspace_id", workspaceId);
    data = result.data;
    error = result.error;
  } catch (caughtError) {
    logger.error(
      "[source-readiness] Workspace source query threw",
      caughtError,
      { workspaceId }
    );
    return sourceReadinessLoadError();
  }

  if (error) {
    logger.error("[source-readiness] Failed to load workspace sources", error, {
      workspaceId,
    });
    return sourceReadinessLoadError();
  }

  const configuredSources = (
    (data ?? []) as Array<Pick<Source, "id" | "type" | "name" | "credentials">>
  ).filter(source => isConfiguredIntegrationSource(source as Source));
  const configuredSourceTypes = Array.from(
    new Set(configuredSources.map(source => String(source.type)))
  ).sort();

  return {
    configuredSources,
    configuredSourceTypes,
    hasConfiguredSources: configuredSources.length > 0,
    hasWhatsApp: configuredSourceTypes.includes("whatsapp"),
    loadError: false,
  };
}
