import "server-only";

import { isDeepStrictEqual } from "node:util";

import connectDB from "@/lib/mongoose";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { hasWhatsAppFlowProvisioningSourceRebindBlocker } from "@/lib/whatsapp/flows/provisioning-operation-store";
import {
  whatsAppFlowSourceBindingFenceStore,
  WhatsAppFlowSourceBindingFenceConflictError,
  type WhatsAppSourceBindingSnapshot,
} from "@/lib/whatsapp/flows/source-binding-fence-store";
import { clearWhatsAppSendContextCache } from "@/lib/whatsapp/send-context";
import { invalidateWhatsAppSourceResolutionCache } from "@/lib/whatsapp/source-resolver";
import { Scenario } from "@/models/scenario";

export class ManagedWhatsAppFlowSourceRebindError extends Error {
  readonly code = "WHATSAPP_FLOW_SOURCE_REBIND_BLOCKED";

  constructor() {
    super(
      "This WhatsApp source is bound to a managed Flow. Reprovision or remove that Flow binding before connecting a different WhatsApp Business Account."
    );
    this.name = "ManagedWhatsAppFlowSourceRebindError";
  }
}

type WhatsAppCredentialsBuilder = (
  current: Readonly<Record<string, unknown>>
) => Record<string, unknown>;

type WhatsAppCredentialsMutation =
  | {
      buildCredentials: WhatsAppCredentialsBuilder;
      currentCredentials?: never;
      nextCredentials?: never;
    }
  | {
      buildCredentials?: never;
      currentCredentials: Readonly<Record<string, unknown>>;
      nextCredentials: Readonly<Record<string, unknown>>;
    };

function createSnapshotCredentialsMutation(params: {
  currentCredentials: Readonly<Record<string, unknown>>;
  nextCredentials: Readonly<Record<string, unknown>>;
}): {
  currentWabaId: string;
  nextWabaId: string;
  buildCredentials: WhatsAppCredentialsBuilder;
} {
  const currentWabaId = String(
    normalizeWhatsAppCredentials(params.currentCredentials).wabaId || ""
  ).trim();
  const nextWabaId = String(
    normalizeWhatsAppCredentials(params.nextCredentials).wabaId || ""
  ).trim();
  const keys = new Set([
    ...Object.keys(params.currentCredentials),
    ...Object.keys(params.nextCredentials),
  ]);
  const changedKeys = Array.from(keys).filter(
    key =>
      !isDeepStrictEqual(
        params.currentCredentials[key],
        params.nextCredentials[key]
      )
  );

  return {
    currentWabaId,
    nextWabaId,
    buildCredentials: current => {
      const merged = { ...current };
      for (const key of changedKeys) {
        if (!isDeepStrictEqual(current[key], params.currentCredentials[key])) {
          throw new WhatsAppFlowSourceBindingFenceConflictError();
        }
        merged[key] = params.nextCredentials[key];
      }
      return merged;
    },
  };
}

export function invalidateWhatsAppSourceBindingCaches(params: {
  workspaceId: string;
  sourceId: string;
}): void {
  clearWhatsAppSendContextCache(params);
  invalidateWhatsAppSourceResolutionCache();
}

export async function loadCurrentWhatsAppSourceWabaBindings(params: {
  workspaceId: string;
  sourceIds: readonly string[];
}): Promise<Record<string, string>> {
  const workspaceId = params.workspaceId.trim();
  const uniqueSourceIds = new Set<string>();
  for (const candidate of params.sourceIds) {
    const sourceId = candidate.trim();
    if (sourceId) uniqueSourceIds.add(sourceId);
    if (uniqueSourceIds.size === 1_000) break;
  }
  const sourceIds = Array.from(uniqueSourceIds);
  if (!workspaceId || sourceIds.length === 0) return {};

  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("id, credentials")
    .eq("workspace_id", workspaceId)
    .eq("type", "whatsapp")
    .in("id", sourceIds);
  if (error) return {};

  const bindings: Record<string, string> = {};
  for (const source of data || []) {
    const sourceId = String(source.id || "").trim();
    const wabaId = String(
      normalizeWhatsAppCredentials(source.credentials).wabaId || ""
    ).trim();
    if (sourceId && wabaId) bindings[sourceId] = wabaId;
  }
  return bindings;
}

async function assertManagedWhatsAppFlowSourceRebindAllowed(params: {
  workspaceId: string;
  sourceId: string;
  currentCredentials: unknown;
  nextWabaId: string;
}): Promise<void> {
  const workspaceId = params.workspaceId.trim();
  const sourceId = params.sourceId.trim();
  const nextWabaId = params.nextWabaId.trim();
  const currentWabaId = String(
    normalizeWhatsAppCredentials(params.currentCredentials).wabaId || ""
  ).trim();
  if (!workspaceId || !sourceId || !nextWabaId) {
    throw new ManagedWhatsAppFlowSourceRebindError();
  }
  if (currentWabaId === nextWabaId) return;

  await connectDB();
  const boundScenario = await Scenario.exists({
    workspaceId,
    deletedAt: null,
    $or: [
      {
        "nodes.data.actionFlowConfig.managedProvisioning.sourceId": sourceId,
      },
      {
        "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.managedProvisioning.sourceId":
          sourceId,
      },
      {
        "nodes.data.actionFlowConfig.providerReference.sourceId": sourceId,
      },
      {
        "nodes.data.actionWhatsAppServiceMessage.message.flowConfig.providerReference.sourceId":
          sourceId,
      },
    ],
  });
  if (boundScenario) throw new ManagedWhatsAppFlowSourceRebindError();

  const provisioningBlocker =
    await hasWhatsAppFlowProvisioningSourceRebindBlocker({
      workspaceId,
      sourceId,
      wabaId: currentWabaId,
    });
  if (provisioningBlocker) throw new ManagedWhatsAppFlowSourceRebindError();
}

export async function updateCurrentWhatsAppSourceCredentials(params: {
  workspaceId: string;
  sourceId: string;
  expectedWabaId: string;
  expectedPhoneNumberId?: string;
  expectedCredentials?: Readonly<Record<string, unknown>>;
  buildCredentials: WhatsAppCredentialsBuilder;
  sourcePatch?: { name?: string };
}): Promise<WhatsAppSourceBindingSnapshot> {
  const expectedPhoneNumberId = params.expectedPhoneNumberId?.trim();
  const expectedCredentialEntries = Object.entries(
    params.expectedCredentials || {}
  );
  const hasCredentialPreconditions = expectedCredentialEntries.length > 0;
  const buildCredentials: WhatsAppCredentialsBuilder =
    params.expectedPhoneNumberId === undefined && !hasCredentialPreconditions
      ? params.buildCredentials
      : current => {
          if (params.expectedPhoneNumberId !== undefined) {
            const currentPhoneNumberId = String(
              normalizeWhatsAppCredentials(current).phoneNumberId || ""
            ).trim();
            if (currentPhoneNumberId !== expectedPhoneNumberId) {
              throw new WhatsAppFlowSourceBindingFenceConflictError();
            }
          }
          for (const [key, expectedValue] of expectedCredentialEntries) {
            if (!isDeepStrictEqual(current[key], expectedValue)) {
              throw new WhatsAppFlowSourceBindingFenceConflictError();
            }
          }
          return params.buildCredentials(current);
        };
  const updated = await whatsAppFlowSourceBindingFenceStore.updateCurrent({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    expectedWabaId: params.expectedWabaId,
    buildCredentials,
    ...(params.sourcePatch ? { sourcePatch: params.sourcePatch } : {}),
  });
  invalidateWhatsAppSourceBindingCaches({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
  });
  return updated;
}

export async function updateCurrentWhatsAppSourceCredentialsFromSnapshot(params: {
  workspaceId: string;
  sourceId: string;
  expectedPhoneNumberId?: string;
  expectedCredentials?: Readonly<Record<string, unknown>>;
  currentCredentials: Readonly<Record<string, unknown>>;
  nextCredentials: Readonly<Record<string, unknown>>;
  sourcePatch?: { name?: string };
}): Promise<WhatsAppSourceBindingSnapshot> {
  const mutation = createSnapshotCredentialsMutation(params);
  if (mutation.currentWabaId !== mutation.nextWabaId) {
    throw new WhatsAppFlowSourceBindingFenceConflictError();
  }

  return updateCurrentWhatsAppSourceCredentials({
    workspaceId: params.workspaceId,
    sourceId: params.sourceId,
    expectedWabaId: mutation.currentWabaId,
    ...(params.expectedPhoneNumberId !== undefined
      ? { expectedPhoneNumberId: params.expectedPhoneNumberId }
      : {}),
    ...(params.expectedCredentials
      ? { expectedCredentials: params.expectedCredentials }
      : {}),
    buildCredentials: mutation.buildCredentials,
    ...(params.sourcePatch ? { sourcePatch: params.sourcePatch } : {}),
  });
}

export function createWhatsAppSourceCredentialSnapshotSaver(params: {
  workspaceId: string;
  sourceId: string;
  expectedPhoneNumberId?: string;
  currentCredentials: Readonly<Record<string, unknown>>;
}): (
  nextCredentials: Readonly<Record<string, unknown>>
) => Promise<WhatsAppSourceBindingSnapshot> {
  let currentCredentials = params.currentCredentials;

  return async nextCredentials => {
    const updated = await updateCurrentWhatsAppSourceCredentialsFromSnapshot({
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      ...(params.expectedPhoneNumberId !== undefined
        ? { expectedPhoneNumberId: params.expectedPhoneNumberId }
        : {}),
      currentCredentials,
      nextCredentials,
    });
    currentCredentials = nextCredentials;
    return updated;
  };
}

export async function updateManagedWhatsAppSourceBinding(
  params: {
    workspaceId: string;
    sourceId: string;
    currentWabaId: string;
    nextWabaId: string;
    semanticOperationId: string;
    sourcePatch?: { name?: string };
  } & WhatsAppCredentialsMutation
): Promise<WhatsAppSourceBindingSnapshot> {
  const workspaceId = params.workspaceId.trim();
  const sourceId = params.sourceId.trim();
  const currentWabaId = params.currentWabaId.trim();
  const nextWabaId = params.nextWabaId.trim();
  if (!workspaceId || !sourceId || !nextWabaId) {
    throw new ManagedWhatsAppFlowSourceRebindError();
  }

  let buildCredentials: WhatsAppCredentialsBuilder;
  if (params.buildCredentials) {
    buildCredentials = params.buildCredentials;
  } else {
    const mutation = createSnapshotCredentialsMutation({
      currentCredentials: params.currentCredentials,
      nextCredentials: params.nextCredentials,
    });
    if (
      mutation.currentWabaId !== currentWabaId ||
      mutation.nextWabaId !== nextWabaId
    ) {
      throw new ManagedWhatsAppFlowSourceRebindError();
    }
    buildCredentials = mutation.buildCredentials;
  }

  try {
    if (currentWabaId === nextWabaId) {
      return await updateCurrentWhatsAppSourceCredentials({
        workspaceId,
        sourceId,
        expectedWabaId: currentWabaId,
        buildCredentials,
        ...(params.sourcePatch ? { sourcePatch: params.sourcePatch } : {}),
      });
    }

    const lease = await whatsAppFlowSourceBindingFenceStore.acquire({
      workspaceId,
      sourceId,
      expectedWabaId: currentWabaId,
      kind: "REBIND",
      semanticOperationId: params.semanticOperationId,
    });
    try {
      const current =
        await whatsAppFlowSourceBindingFenceStore.assertCurrent(lease);
      await assertManagedWhatsAppFlowSourceRebindAllowed({
        workspaceId,
        sourceId,
        currentCredentials: current.credentials,
        nextWabaId,
      });
      const updated = await whatsAppFlowSourceBindingFenceStore.commit({
        lease,
        nextWabaId,
        buildCredentials,
        ...(params.sourcePatch ? { sourcePatch: params.sourcePatch } : {}),
      });
      invalidateWhatsAppSourceBindingCaches({ workspaceId, sourceId });
      return updated;
    } finally {
      await whatsAppFlowSourceBindingFenceStore
        .release(lease)
        .catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ManagedWhatsAppFlowSourceRebindError) throw error;
    if (error instanceof WhatsAppFlowSourceBindingFenceConflictError) {
      throw new ManagedWhatsAppFlowSourceRebindError();
    }
    throw error;
  }
}
