import {
  acquireWhatsAppMetaReadPermit,
  acquireWhatsAppMetaReadLock,
  buildWhatsAppMetaRateLimitCredentialPatch,
  META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD,
  releaseWhatsAppMetaReadPermit,
  setCachedWhatsAppMetaReadCooldownUntil,
} from "@/lib/whatsapp/meta-read-policy";
import { buildCacheKey, cache } from "@icecore/shared/lib/cache";
import {
  MetaGraphRequestError,
  getMetaGraphRateLimitMetadata,
  type MetaGraphAPIError,
} from "@icecore/shared/lib/meta/api";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import {
  WhatsAppTemplateCatalogError,
  type WhatsAppTemplateCatalogMetadata,
  type WhatsAppTemplateCatalogRefreshOutcome,
} from "./catalog-contracts";

// Reuse the existing WABA-wide Meta permit and shared cache. The flow-facts
// cache cannot protect complete catalog pagination or coordinate provider reads.
const FRESHNESS_MS = 15 * 60_000;
const MINIMUM_INTERVAL_MS = 60_000;
const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
const GENERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const WAIT_INTERVAL_MS = 100;
const WAIT_ATTEMPTS = 10;

type Failure = {
  code: WhatsAppTemplateCatalogError["code"];
  message: string;
  providerCode?: number;
  providerStatus?: number;
  retryAt: string | null;
  graphError?: { status: number; metaError?: MetaGraphAPIError };
};
type ResourceState<T> = {
  lastAttemptAt: string;
  fetchedAt?: string;
  value?: T;
  failure?: Failure;
  invalidated?: boolean;
  refreshing?: boolean;
  publicationId?: string;
};
type ResourceInput<T> = {
  workspaceId: string;
  sourceId: string;
  wabaId?: string;
  resource: string[];
  credentials: Readonly<Record<string, unknown>>;
  force?: boolean;
  load: () => Promise<T>;
  valid: (value: unknown) => value is T;
  persistRateLimit: (error: unknown) => Promise<string>;
  recoverable: (error: unknown) => boolean;
  success?: () => Promise<void>;
};

type Generation = { id: string; pendingUntil?: string };
type Identity = { workspaceId: string; sourceId: string; wabaId?: string };
function generationKey(input: Identity): string {
  return buildCacheKey(
    "whatsapp:template-catalog-generation:v1",
    input.wabaId
      ? ["waba", input.wabaId]
      : ["source", input.workspaceId, input.sourceId]
  );
}
function resourceKey(
  input: Identity,
  resource: string[],
  generation: string
): string {
  return buildCacheKey("whatsapp:template-catalog:v1", [
    input.workspaceId,
    input.sourceId,
    ...resource,
    generation,
  ]);
}
function attemptKey(input: Identity): string {
  return buildCacheKey(
    "whatsapp:template-catalog-attempt:v1",
    input.wabaId ? ["waba", input.wabaId] : ["source", input.sourceId]
  );
}
function scopesKey(wabaId: string): string {
  return buildCacheKey("whatsapp:template-catalog-scopes:v1", [wabaId]);
}
async function registerScope(input: Identity): Promise<void> {
  if (!input.wabaId) return;
  const key = scopesKey(input.wabaId);
  const current = await cache.readWithStatus<Identity[]>(key);
  if (current.status === "unavailable") return;
  const scopes =
    current.status === "hit" && Array.isArray(current.value)
      ? current.value
          .filter(
            scope =>
              scope &&
              typeof scope.workspaceId === "string" &&
              typeof scope.sourceId === "string" &&
              scope.wabaId === input.wabaId
          )
          .map(scope => ({
            workspaceId: scope.workspaceId,
            sourceId: scope.sourceId,
            wabaId: scope.wabaId,
          }))
      : [];
  if (
    scopes.some(
      scope =>
        scope.workspaceId === input.workspaceId &&
        scope.sourceId === input.sourceId
    )
  ) {
    await cache.writeWithStatus(key, scopes, GENERATION_TTL_SECONDS);
    return;
  }
  // The registry is bounded; an unregistered scope becomes cold after a WABA
  // generation change rather than ever retaining a pre-mutation snapshot.
  await cache.writeWithStatus(
    key,
    [
      ...scopes.slice(-255),
      {
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        wabaId: input.wabaId,
      },
    ],
    GENERATION_TTL_SECONDS
  );
}
function generationId(value: Generation | undefined): string {
  return value?.id ?? "initial";
}
class InvalidatedCatalogError extends WhatsAppTemplateCatalogError {}
class CatalogMutationInProgressError extends WhatsAppTemplateCatalogError {}

function failureError(failure: Failure): Error {
  if (failure.graphError)
    return new MetaGraphRequestError({
      ...failure.graphError,
      message: failure.message,
      statusText: "",
      url: "",
      details: undefined,
    });
  return new WhatsAppTemplateCatalogError(failure);
}

function blockedError(
  outcome: WhatsAppTemplateCatalogRefreshOutcome,
  retryAt: string | null,
  credentials: Readonly<Record<string, unknown>>,
  failure?: Failure
): Error {
  if (outcome === "cooldown") {
    const savedCode = Number(credentials.meta_diagnostics_last_error_code);
    return new WhatsAppTemplateCatalogError({
      code: "WHATSAPP_TEMPLATES_RATE_LIMITED",
      message:
        failure?.message ??
        "Meta temporarily limited WhatsApp template requests. Try again after the cooldown.",
      retryAt,
      providerCode:
        failure?.providerCode ??
        (Number.isFinite(savedCode) && savedCode > 0 ? savedCode : undefined),
      providerStatus: failure?.providerStatus,
    });
  }
  if (failure) return failureError(failure);
  return new WhatsAppTemplateCatalogError({
    code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
    message:
      outcome === "in_progress"
        ? "WhatsApp templates are being refreshed. Try again shortly."
        : "WhatsApp templates cannot be refreshed right now. Try again shortly.",
    retryAt,
  });
}

async function readResource<T>(input: ResourceInput<T>): Promise<{
  value: T;
  catalog: WhatsAppTemplateCatalogMetadata;
}> {
  const revision = await cache.readWithStatus<Generation>(generationKey(input));
  if (revision.status === "unavailable")
    throw blockedError("coordination_unavailable", null, input.credentials);
  const generation = revision.status === "hit" ? revision.value : undefined;
  if (
    generation?.pendingUntil &&
    Date.parse(generation.pendingUntil) > Date.now()
  ) {
    throw blockedError(
      "in_progress",
      generation.pendingUntil,
      input.credentials
    );
  }
  const capturedGeneration = generationId(generation);
  const valueKey = resourceKey(input, input.resource, capturedGeneration);
  const assertCurrentGeneration = async () => {
    const current = await cache.readWithStatus<Generation>(
      generationKey(input)
    );
    if (
      current.status === "unavailable" ||
      generationId(current.status === "hit" ? current.value : undefined) !==
        capturedGeneration
    ) {
      throw new InvalidatedCatalogError({
        code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
        message:
          "The template catalog changed during refresh. Try again shortly.",
      });
    }
  };
  const readState = async (): Promise<ResourceState<T> | undefined> => {
    const result = await cache.readWithStatus<ResourceState<T>>(valueKey);
    if (result.status === "unavailable")
      throw blockedError("coordination_unavailable", null, input.credentials);
    const state = result.status === "hit" ? result.value : undefined;
    if (!state || typeof state.lastAttemptAt !== "string") return undefined;
    if (
      state.value !== undefined &&
      (!input.valid(state.value) ||
        !state.fetchedAt ||
        !Number.isFinite(Date.parse(state.fetchedAt)))
    )
      return undefined;
    return state;
  };
  let state = await readState();
  const respond = (
    outcome: WhatsAppTemplateCatalogRefreshOutcome,
    retryAt: string | null = null,
    source: "live" | "cache" = "cache"
  ) => {
    if (state?.value === undefined || !state.fetchedAt)
      throw blockedError(outcome, retryAt, input.credentials, state?.failure);
    const stale =
      Date.now() - Date.parse(state.fetchedAt) >= FRESHNESS_MS ||
      !["fresh", "succeeded", "minimum_interval"].includes(outcome) ||
      !!state.failure ||
      !!state.invalidated ||
      !!state.refreshing;
    return {
      value: state.value,
      catalog: {
        source,
        stale,
        fetchedAt: state.fetchedAt,
        wabaId: input.wabaId ?? "",
        refreshOutcome: outcome,
        retryAt,
        ...(state.failure?.providerCode !== undefined
          ? { providerCode: state.failure.providerCode }
          : {}),
        ...(stale
          ? {
              warning:
                "Showing the last verified Meta template catalog. Refresh is temporarily unavailable.",
            }
          : {}),
      } satisfies WhatsAppTemplateCatalogMetadata,
    };
  };
  const sharedAttempt = await cache.readWithStatus<string>(attemptKey(input));
  if (sharedAttempt.status === "unavailable")
    return respond("coordination_unavailable");
  const attempt = [
    state?.lastAttemptAt,
    sharedAttempt.status === "hit" ? sharedAttempt.value : undefined,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && Number.isFinite(Date.parse(value))
    )
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const needsRead =
    !state?.fetchedAt || !!state.invalidated || !!state.refreshing;
  const permit = state?.refreshing
    ? await acquireWhatsAppMetaReadLock({
        sourceId: input.sourceId,
        wabaId: input.wabaId,
        additionalCooldownUntil:
          typeof input.credentials[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD] ===
          "string"
            ? (input.credentials[
                META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD
              ] as string)
            : null,
      })
    : await acquireWhatsAppMetaReadPermit({
        sourceId: input.sourceId,
        wabaId: input.wabaId,
        credentials: {
          [META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]:
            input.credentials[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD],
          meta_diagnostics_last_attempt_at: state?.refreshing
            ? undefined
            : attempt,
          meta_diagnostics_last_success_at:
            state?.refreshing || state?.invalidated
              ? undefined
              : state?.fetchedAt,
        },
        explicitRefresh: input.force || needsRead,
      });
  if (permit.outcome === "in_progress") {
    const priorPublication = state?.publicationId;
    // Cold concurrent readers wait a bounded time for a complete publication.
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL_MS));
      state = await readState();
      await assertCurrentGeneration();
      if (
        state?.value !== undefined &&
        !state.refreshing &&
        !state.invalidated &&
        state.publicationId !== priorPublication &&
        state.fetchedAt &&
        Date.now() - Date.parse(state.fetchedAt) < FRESHNESS_MS
      )
        return respond("fresh");
      if (state?.failure)
        return respond(
          state.failure.code === "WHATSAPP_TEMPLATES_RATE_LIMITED"
            ? "cooldown"
            : "failed",
          state.failure.retryAt
        );
    }
    return respond(
      "in_progress",
      new Date(Date.now() + MINIMUM_INTERVAL_MS).toISOString()
    );
  }
  if (permit.outcome !== "acquired") {
    const retryAt =
      permit.cooldownUntil ??
      (permit.outcome === "minimum_interval" && attempt
        ? new Date(
            Date.parse(attempt) +
              (input.force || needsRead ? MINIMUM_INTERVAL_MS : FRESHNESS_MS)
          ).toISOString()
        : null);
    return respond(permit.outcome, retryAt);
  }

  const now = new Date();
  try {
    if (
      state?.refreshing &&
      attempt &&
      now.getTime() - Date.parse(attempt) < MINIMUM_INTERVAL_MS
    ) {
      return respond(
        "minimum_interval",
        new Date(Date.parse(attempt) + MINIMUM_INTERVAL_MS).toISOString()
      );
    }
    // Recheck after acquiring the lock: a previous reader may have published
    // between our first cache read and lock acquisition.
    state = await readState();
    await assertCurrentGeneration();
    if (
      state?.fetchedAt &&
      !input.force &&
      !state.invalidated &&
      Date.now() - Date.parse(state.fetchedAt) < FRESHNESS_MS &&
      !state.failure
    )
      return respond("fresh");
    state = { ...state, lastAttemptAt: now.toISOString(), refreshing: true };
    if (
      (await cache.writeWithStatus(valueKey, state, SNAPSHOT_TTL_SECONDS)) !==
      "stored"
    )
      return respond("coordination_unavailable");
    if (
      (await cache.writeWithStatus(
        attemptKey(input),
        now.toISOString(),
        FRESHNESS_MS / 1_000
      )) !== "stored"
    )
      return respond("coordination_unavailable");
    const previous = state;
    const value = await input.load();
    await assertCurrentGeneration();
    state = {
      value,
      lastAttemptAt: now.toISOString(),
      fetchedAt: new Date().toISOString(),
      publicationId: permit.lockToken,
    };
    const published = await cache.publishIfLockOwned({
      lockKey: permit.lockKey,
      ownerToken: permit.lockToken,
      valueKey,
      value: state,
      ttlSeconds: SNAPSHOT_TTL_SECONDS,
    });
    if (published !== "published") {
      state = previous;
      return respond("coordination_unavailable");
    }
    await assertCurrentGeneration();
    await registerScope(input);
    await input.success?.();
    return respond("succeeded", null, "live");
  } catch (error) {
    if (error instanceof InvalidatedCatalogError) throw error;
    const rate = getMetaGraphRateLimitMetadata(error);
    if (!rate && !input.recoverable(error)) {
      if (error instanceof MetaGraphRequestError) {
        state = {
          lastAttemptAt: now.toISOString(),
          failure: {
            code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
            message: error.message,
            retryAt: null,
            graphError: { status: error.status, metaError: error.metaError },
          },
        };
        await cache.publishIfLockOwned({
          lockKey: permit.lockKey,
          ownerToken: permit.lockToken,
          valueKey,
          value: state,
          ttlSeconds: SNAPSHOT_TTL_SECONDS,
        });
      }
      throw error;
    }
    const retryAt = rate
      ? await input.persistRateLimit(error)
      : new Date(now.getTime() + FRESHNESS_MS).toISOString();
    const failure: Failure = {
      code: rate
        ? "WHATSAPP_TEMPLATES_RATE_LIMITED"
        : error instanceof WhatsAppTemplateCatalogError
          ? error.code
          : "WHATSAPP_TEMPLATES_UNAVAILABLE",
      message:
        error instanceof Error
          ? error.message
          : "WhatsApp templates are temporarily unavailable.",
      retryAt,
      providerCode: rate?.code,
      providerStatus: rate?.status,
    };
    state = {
      ...state,
      lastAttemptAt: now.toISOString(),
      refreshing: false,
      failure,
    };
    await cache.publishIfLockOwned({
      lockKey: permit.lockKey,
      ownerToken: permit.lockToken,
      valueKey,
      value: state,
      ttlSeconds: SNAPSHOT_TTL_SECONDS,
    });
    return respond(rate ? "rate_limited" : "failed", retryAt);
  } finally {
    await releaseWhatsAppMetaReadPermit(permit);
  }
}

export async function readWhatsAppTemplateCatalog(
  input: Omit<ResourceInput<WhatsAppTemplate[]>, "resource" | "valid"> & {
    wabaId: string;
  }
) {
  const result = await readResource({
    ...input,
    resource: ["waba", input.wabaId],
    valid: (value): value is WhatsAppTemplate[] =>
      Array.isArray(value) &&
      value.every(
        template =>
          template &&
          typeof template.id === "string" &&
          typeof template.name === "string" &&
          typeof template.language === "string" &&
          typeof template.status === "string"
      ),
  });
  return { templates: result.value, catalog: result.catalog };
}

export async function readWhatsAppTemplateAccountDiscovery<T>(
  input: Omit<ResourceInput<T[]>, "resource" | "valid" | "wabaId"> & {
    bindingKey: string;
  }
): Promise<T[]> {
  const result = await readResource({
    ...input,
    resource: ["discovery", input.bindingKey],
    valid: (value): value is T[] => Array.isArray(value),
  });
  return result.value;
}

export type WhatsAppTemplateCatalogPatch =
  | { type: "upsert"; template: WhatsAppTemplate }
  | { type: "remove"; templateId?: string; templateName?: string }
  | {
      type: "patch";
      templateId?: string;
      name?: string;
      language?: string;
      remove?: boolean;
      patch:
        | Partial<WhatsAppTemplate>
        | ((current: WhatsAppTemplate) => Partial<WhatsAppTemplate>);
    };
type CatalogMutation = {
  identity: Identity;
  generation: Generation;
  valueKey: string;
  previous?: ResourceState<WhatsAppTemplate[]>;
  lockKey: string;
  lockToken: string;
  snapshots: Array<{
    identity: Identity;
    valueKey: string;
    previous: ResourceState<WhatsAppTemplate[]>;
  }>;
};

function applyPatch(
  templates: WhatsAppTemplate[],
  patch: WhatsAppTemplateCatalogPatch
): WhatsAppTemplate[] {
  if (patch.type === "remove")
    return templates.filter(template =>
      patch.templateId
        ? template.id !== patch.templateId
        : template.name !== patch.templateName
    );
  if (patch.type === "patch")
    return templates.flatMap(template => {
      const matches = patch.templateId
        ? template.id === patch.templateId
        : !!patch.name &&
          template.name === patch.name &&
          (!patch.language || template.language === patch.language);
      if (!matches) return [template];
      if (patch.remove) return [];
      const changes =
        typeof patch.patch === "function" ? patch.patch(template) : patch.patch;
      return [
        {
          ...template,
          ...changes,
          id: template.id,
          name: template.name,
          language: template.language,
        },
      ];
    });
  const existing = templates.findIndex(
    template => template.id === patch.template.id
  );
  if (existing < 0) return [...templates, patch.template];
  return templates.map((template, index) =>
    index === existing ? patch.template : template
  );
}

/** Publish the barrier before POST/DELETE, so cache failure cannot revive old data. */
export async function beginWhatsAppTemplateCatalogMutation(input: {
  workspaceId: string;
  sourceId?: string;
  wabaId?: string;
  expectedGeneration?: string;
}): Promise<CatalogMutation> {
  if (!input.sourceId) throw blockedError("coordination_unavailable", null, {});
  const identity: Identity = {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    wabaId: input.wabaId,
  };
  const lockKey = buildCacheKey(
    "whatsapp:template-catalog-mutation:v1",
    input.wabaId ? ["waba", input.wabaId] : ["source", input.sourceId]
  );
  const lockToken = crypto.randomUUID();
  const acquisition = await cache.acquireLock(lockKey, lockToken, 120);
  if (acquisition === "contended")
    throw new CatalogMutationInProgressError({
      code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
      message: "The template catalog is being updated. Try again shortly.",
    });
  if (acquisition !== "acquired")
    throw blockedError("coordination_unavailable", null, {});
  try {
    const revision = await cache.readWithStatus<Generation>(
      generationKey(identity)
    );
    if (revision.status === "unavailable")
      throw blockedError("coordination_unavailable", null, {});
    if (
      input.expectedGeneration !== undefined &&
      generationId(revision.status === "hit" ? revision.value : undefined) !==
        input.expectedGeneration
    ) {
      throw new InvalidatedCatalogError({
        code: "WHATSAPP_TEMPLATES_UNAVAILABLE",
        message:
          "The template changed during readback. Its older result was not cached.",
      });
    }
    const oldKey = resourceKey(
      identity,
      ["waba", input.wabaId ?? ""],
      generationId(revision.status === "hit" ? revision.value : undefined)
    );
    const previous =
      await cache.readWithStatus<ResourceState<WhatsAppTemplate[]>>(oldKey);
    if (previous.status === "unavailable")
      throw blockedError("coordination_unavailable", null, {});
    const generation = {
      id: crypto.randomUUID(),
      pendingUntil: new Date(Date.now() + 120_000).toISOString(),
    };
    if (
      (await cache.writeWithStatus(
        generationKey(identity),
        generation,
        GENERATION_TTL_SECONDS
      )) !== "stored"
    )
      throw blockedError("coordination_unavailable", null, {});
    const valueKey = resourceKey(
      identity,
      ["waba", input.wabaId ?? ""],
      generation.id
    );
    const scopes = input.wabaId
      ? await cache.readWithStatus<Identity[]>(scopesKey(input.wabaId))
      : { status: "miss" as const };
    if (scopes.status === "unavailable")
      throw blockedError("coordination_unavailable", null, {});
    const identities =
      scopes.status === "hit" && Array.isArray(scopes.value)
        ? [...scopes.value]
        : [];
    if (
      !identities.some(
        scope =>
          scope.workspaceId === identity.workspaceId &&
          scope.sourceId === identity.sourceId
      )
    )
      identities.push(identity);
    const snapshots: CatalogMutation["snapshots"] = [];
    for (const scope of identities) {
      const scopedPrevious =
        scope.workspaceId === identity.workspaceId &&
        scope.sourceId === identity.sourceId
          ? previous
          : await cache.readWithStatus<ResourceState<WhatsAppTemplate[]>>(
              resourceKey(
                scope,
                ["waba", input.wabaId ?? ""],
                generationId(
                  revision.status === "hit" ? revision.value : undefined
                )
              )
            );
      if (scopedPrevious.status === "unavailable")
        throw blockedError("coordination_unavailable", null, {});
      if (
        scopedPrevious.status === "hit" &&
        scopedPrevious.value.value &&
        scopedPrevious.value.fetchedAt
      ) {
        snapshots.push({
          identity: scope,
          previous: scopedPrevious.value,
          valueKey: resourceKey(
            scope,
            ["waba", input.wabaId ?? ""],
            generation.id
          ),
        });
      }
    }
    return {
      identity,
      generation,
      valueKey,
      lockKey,
      lockToken,
      previous: previous.status === "hit" ? previous.value : undefined,
      snapshots,
    };
  } catch (error) {
    await cache.compareAndDelete(lockKey, lockToken);
    throw error;
  }
}

/** Only a previous complete catalog can be patched; a single readback is not a catalog. */
export async function finishWhatsAppTemplateCatalogMutation(
  mutation: CatalogMutation,
  patch?: WhatsAppTemplateCatalogPatch
): Promise<void> {
  try {
    const current = await cache.readWithStatus<Generation>(
      generationKey(mutation.identity)
    );
    if (current.status !== "hit" || current.value.id !== mutation.generation.id)
      return;
    const snapshots = mutation.snapshots.length
      ? mutation.snapshots
      : [
          {
            identity: mutation.identity,
            valueKey: mutation.valueKey,
            previous: mutation.previous,
          },
        ];
    for (const snapshot of snapshots) {
      const previous = snapshot.previous;
      const value =
        previous?.value && previous.fetchedAt
          ? patch
            ? applyPatch(previous.value, patch)
            : previous.value
          : undefined;
      const state: ResourceState<WhatsAppTemplate[]> = {
        lastAttemptAt: previous?.lastAttemptAt ?? new Date().toISOString(),
        ...(value !== undefined
          ? { value, fetchedAt: previous?.fetchedAt }
          : {}),
        invalidated: true,
      };
      if (
        (await cache.writeWithStatus(
          snapshot.valueKey,
          state,
          SNAPSHOT_TTL_SECONDS
        )) !== "stored"
      )
        return;
    }
    // Keep the already published generation on failure; never return to initial.
    await cache.publishIfLockOwned({
      lockKey: mutation.lockKey,
      ownerToken: mutation.lockToken,
      valueKey: generationKey(mutation.identity),
      value: { id: mutation.generation.id },
      ttlSeconds: GENERATION_TTL_SECONDS,
    });
    await registerScope(mutation.identity);
  } finally {
    await cache.compareAndDelete(mutation.lockKey, mutation.lockToken);
  }
}

export async function patchWhatsAppTemplateCatalog(
  input: Identity & {
    patch: WhatsAppTemplateCatalogPatch;
    expectedGeneration?: string;
  }
): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
    try {
      const mutation = await beginWhatsAppTemplateCatalogMutation(input);
      await finishWhatsAppTemplateCatalogMutation(mutation, input.patch);
      return;
    } catch (error) {
      if (
        !(error instanceof CatalogMutationInProgressError) ||
        attempt === WAIT_ATTEMPTS - 1
      )
        throw error;
      await new Promise(resolve => setTimeout(resolve, WAIT_INTERVAL_MS));
    }
  }
}

export async function patchWhatsAppTemplateCatalogState(
  input: Identity & {
    templateId?: string;
    name?: string;
    language?: string;
    remove?: boolean;
    patch:
      | Partial<WhatsAppTemplate>
      | ((current: WhatsAppTemplate) => Partial<WhatsAppTemplate>);
  }
): Promise<void> {
  if (!input.templateId && !input.name) return;
  await patchWhatsAppTemplateCatalog({
    ...input,
    patch: {
      type: "patch",
      templateId: input.templateId,
      name: input.name,
      language: input.language,
      remove: input.remove,
      patch: input.patch,
    },
  });
}

export async function readWhatsAppTemplateCatalogGeneration(
  input: Identity
): Promise<string | undefined> {
  const current = await cache.readWithStatus<Generation>(generationKey(input));
  return current.status === "unavailable" ||
    (current.status === "hit" && !!current.value.pendingUntil)
    ? undefined
    : generationId(current.status === "hit" ? current.value : undefined);
}

export async function protectWhatsAppTemplateRateLimit(input: {
  wabaId?: string;
  credentials: Readonly<Record<string, unknown>>;
  error: unknown;
  persistPatch: (
    build: (
      current: Readonly<Record<string, unknown>>
    ) => Record<string, unknown>
  ) => Promise<Readonly<Record<string, unknown>> | void>;
}): Promise<string> {
  const patch = buildWhatsAppMetaRateLimitCredentialPatch(input.credentials, {
    error: input.error,
  });
  const retryAt = String(patch[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD]);
  if (input.wabaId)
    await setCachedWhatsAppMetaReadCooldownUntil(input.wabaId, retryAt);
  const persisted = await input.persistPatch(current => ({
    ...current,
    ...buildWhatsAppMetaRateLimitCredentialPatch(current, {
      error: input.error,
    }),
  }));
  const persistedRetryAt = persisted?.[META_DIAGNOSTICS_COOLDOWN_UNTIL_FIELD];
  const effectiveRetryAt =
    typeof persistedRetryAt === "string" &&
    Date.parse(persistedRetryAt) > Date.parse(retryAt)
      ? persistedRetryAt
      : retryAt;
  if (input.wabaId)
    await setCachedWhatsAppMetaReadCooldownUntil(
      input.wabaId,
      effectiveRetryAt
    );
  return effectiveRetryAt;
}
