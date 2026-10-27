/**
 * Worker-owned handlers for Meta WhatsApp template lifecycle webhooks:
 * - message_template_status_update
 * - message_template_quality_update
 * - template_category_update / template_correct_category_detection
 * - message_template_components_update
 */
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";

type TemplateStatus =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "PAUSED"
  | "LIMIT_EXCEEDED";
type TemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
type TemplateQuality = "GREEN" | "YELLOW" | "RED";

const PERSISTABLE_STATUSES: ReadonlySet<TemplateStatus> = new Set([
  "APPROVED",
  "PENDING",
  "REJECTED",
  "PAUSED",
  "LIMIT_EXCEEDED",
]);

const UNUSABLE_STATUSES: ReadonlySet<string> = new Set([
  "REJECTED",
  "PAUSED",
  "LIMIT_EXCEEDED",
  "DISABLED",
  "DELETED",
  "PENDING_DELETION",
]);

export interface TemplateStatusUpdateValue {
  event?: string;
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string | null;
  other_info?: { title?: string; description?: string } | null;
  new_category?: string;
  previous_category?: string;
}

export interface TemplateQualityUpdateValue {
  previous_quality_score?: string;
  new_quality_score?: string;
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
}

export interface TemplateCategoryUpdateValue {
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  previous_category?: string;
  new_category?: string;
  correct_category?: string;
}

export interface TemplateComponentsUpdateValue {
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  message_template_element?: string;
  [key: string]: unknown;
}

interface WorkspaceSource {
  id: string;
  workspaceId: string;
}

type ResolvedSourceRow = {
  id?: string;
  workspace_id?: string;
};

type TemplateLifecycleLogger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
};

type WorkspaceAlertSeverity = "info" | "warning" | "critical";

/** What a refresh wrote: Meta's version, and whether the cache held it. */
type RefreshedTemplate = Record<string, unknown> & { components?: unknown; snapshotUpdated?: boolean };

export type TemplateCatalogLifecyclePatch = {
  workspaceId: string;
  sourceId: string;
  wabaId: string;
  templateId?: string;
  name: string;
  language?: string;
  patch: Partial<WhatsAppTemplate> | ((current: WhatsAppTemplate) => Partial<WhatsAppTemplate>);
  remove?: boolean;
};

export type TemplateMirrorRefresh = {
  /** Only a status event's own status is newer than what Meta reads back. */
  keepStoredStatus: boolean;
  overrides: Record<string, unknown>;
  sourceId: string;
  templateId: string;
  wabaId: string;
  workspaceId: string;
};

/**
 * The worker's refresh: reads the template with the token of the source the
 * webhook arrived for, then writes both copies.
 */
export function createTemplateMirrorRefresher(deps: {
  fetchTemplate: (params: {
    accessToken: string;
    templateId: string;
  }) => Promise<Record<string, unknown>>;
  logger: TemplateLifecycleLogger;
  mirrorTemplate: (params: {
    template: Record<string, unknown>;
    workspaceId: string;
  }) => Promise<{ errors: string[]; snapshotUpdated: boolean }>;
  readAccessToken: (credentials: unknown) => string | undefined;
  resolveWhatsAppSourcesByAccountIdentifiers: (params: {
    messagingAccountId?: string;
    wabaId?: string;
  }) => Promise<Array<ResolvedSourceRow & { credentials?: unknown }>>;
}): TemplateLifecycleDependencies["refreshTemplateMirrors"] {
  return async (params) => {
    const sources = await deps.resolveWhatsAppSourcesByAccountIdentifiers({
      wabaId: params.wabaId,
      messagingAccountId: params.wabaId,
    });
    const source = sources.find(
      (row) =>
        row.id === params.sourceId && row.workspace_id === params.workspaceId,
    );
    const accessToken = deps.readAccessToken(source?.credentials);
    if (!accessToken) {
      throw new Error("WhatsApp access token not found for the source");
    }
    const { status, ...fetched } = await deps.fetchTemplate({
      accessToken,
      templateId: params.templateId,
    });
    const template: Record<string, unknown> = {
      ...fetched,
      ...(params.keepStoredStatus ? {} : { status }),
      ...params.overrides,
    };
    const { errors, snapshotUpdated } = await deps.mirrorTemplate({
      template,
      workspaceId: params.workspaceId,
    });
    if (errors.length > 0) {
      deps.logger.warn("WhatsApp template mirror write failed", {
        workspaceId: params.workspaceId,
        templateId: params.templateId,
        errors,
      });
    }
    return { ...template, snapshotUpdated };
  };
}

export type TemplateLifecycleDependencies = {
  connectDB: () => Promise<unknown>;
  createTemplateAudit: (params: {
    workspaceId: string;
    templateId?: string | null;
    templateName: string;
    action: "UPDATE";
    userId: "system:webhook";
    changes: Record<string, unknown>;
  }) => Promise<unknown>;
  findTemplateSnapshot: (filter: Record<string, unknown>) => Promise<{
    _id: unknown;
    components?: unknown;
  } | null>;
  logger: TemplateLifecycleLogger;
  now: () => Date;
  publishWorkspaceAlert: (params: {
    action?: { label: string; url: string };
    dedupeKey: string;
    message: string;
    metadata: Record<string, unknown>;
    title: string;
    type: WorkspaceAlertSeverity;
    workspaceId: string;
  }) => Promise<unknown>;
  /**
   * Re-reads the template from Meta, lays the event's fields over it, and
   * writes both our copies (cache and stored rows). Throws only when Meta
   * could not be read; a copy that could not be written is logged.
   */
  refreshTemplateMirrors: (
    params: TemplateMirrorRefresh,
  ) => Promise<RefreshedTemplate>;
  resolveWhatsAppSourcesByAccountIdentifiers: (params: {
    messagingAccountId?: string;
    wabaId?: string;
  }) => Promise<ResolvedSourceRow[]>;
  retirePendingCampaignTasks: (params: {
    reason: string;
    templateLanguage: string | null;
    templateName: string;
    workspaceId: string;
  }) => Promise<number>;
  updateTemplateSnapshot: (params: {
    filter: Record<string, unknown>;
    set: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Patches known complete catalog rows; a partial webhook never adds a row. */
  patchTemplateCatalog?: (params: TemplateCatalogLifecyclePatch) => Promise<unknown>;
};

function catalogMirrorPatch(refreshed: RefreshedTemplate | null): Partial<WhatsAppTemplate> {
  if (!refreshed) return {};
  const { snapshotUpdated: _snapshotUpdated, ...template } = refreshed;
  return template as Partial<WhatsAppTemplate>;
}

async function patchCatalog(
  deps: Pick<TemplateLifecycleDependencies, "patchTemplateCatalog" | "logger">,
  params: TemplateCatalogLifecyclePatch,
): Promise<void> {
  if (!deps.patchTemplateCatalog || (!params.templateId && !params.language)) return;
  try {
    await deps.patchTemplateCatalog(params);
  } catch (error) {
    deps.logger.warn("WhatsApp template catalog patch failed", {
      workspaceId: params.workspaceId,
      sourceId: params.sourceId,
      wabaId: params.wabaId,
      templateId: params.templateId,
      templateName: params.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function findWorkspacesForWaba(
  deps: Pick<
    TemplateLifecycleDependencies,
    "resolveWhatsAppSourcesByAccountIdentifiers"
  >,
  wabaId: string,
): Promise<WorkspaceSource[]> {
  if (!wabaId) return [];
  const sources = await deps.resolveWhatsAppSourcesByAccountIdentifiers({
    wabaId,
    messagingAccountId: wabaId,
  });
  const seen = new Set<string>();
  return sources
    .filter(
      (row) =>
        typeof row?.id === "string" && typeof row?.workspace_id === "string",
    )
    .map((row) => ({ id: row.id as string, workspaceId: row.workspace_id! }))
    .filter((row) => {
      const key = `${row.workspaceId}:${row.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeTemplateId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isPersistableStatus(event: string): event is TemplateStatus {
  return PERSISTABLE_STATUSES.has(event as TemplateStatus);
}

function isPersistableCategory(
  value: string | undefined | null,
): value is TemplateCategory {
  return (
    value === "MARKETING" || value === "UTILITY" || value === "AUTHENTICATION"
  );
}

function isPersistableQuality(
  value: string | undefined | null,
): value is TemplateQuality {
  return value === "GREEN" || value === "YELLOW" || value === "RED";
}

async function writeAudit(
  deps: Pick<TemplateLifecycleDependencies, "createTemplateAudit" | "logger">,
  params: {
    changes: Record<string, unknown>;
    templateId?: string | null;
    templateName: string;
    workspaceId: string;
  },
): Promise<void> {
  try {
    await deps.createTemplateAudit({
      workspaceId: params.workspaceId,
      templateId: params.templateId || undefined,
      templateName: params.templateName,
      action: "UPDATE",
      userId: "system:webhook",
      changes: params.changes,
    });
  } catch (error) {
    deps.logger.warn("WhatsApp template audit log write failed", {
      workspaceId: params.workspaceId,
      templateName: params.templateName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Both our copies re-read from Meta, or null when Meta could not be read: the
 * webhook's own fields are then all we write, to the cache only.
 */
async function refreshMirrors(
  deps: Pick<
    TemplateLifecycleDependencies,
    "logger" | "refreshTemplateMirrors"
  >,
  params: {
    kind: string;
    keepStoredStatus: boolean;
    overrides?: Record<string, unknown>;
    source: WorkspaceSource;
    templateId: string | null;
    templateName: string;
    wabaId: string;
  },
): Promise<RefreshedTemplate | null> {
  if (!params.templateId) return null;
  try {
    return await deps.refreshTemplateMirrors({
      keepStoredStatus: params.keepStoredStatus,
      overrides: params.overrides ?? {},
      sourceId: params.source.id,
      templateId: params.templateId,
      wabaId: params.wabaId,
      workspaceId: params.source.workspaceId,
    });
  } catch (error) {
    deps.logger.warn(`${params.kind}: template refresh from Meta failed`, {
      workspaceId: params.source.workspaceId,
      templateId: params.templateId,
      templateName: params.templateName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readBodyText(components: unknown): string | null {
  if (!Array.isArray(components)) return null;
  const body = components.find(
    (component) =>
      component &&
      typeof component === "object" &&
      String((component as { type?: unknown }).type || "").toUpperCase() ===
        "BODY",
  ) as { text?: unknown } | undefined;
  return typeof body?.text === "string" ? body.text : null;
}

export function patchBodyComponent(
  components: unknown,
  bodyText: string | null,
): unknown {
  if (!bodyText) return components;

  const base = Array.isArray(components)
    ? components.filter(
        (component) => component && typeof component === "object",
      )
    : [];
  const bodyIndex = base.findIndex(
    (component) =>
      String((component as { type?: unknown }).type || "").toUpperCase() ===
      "BODY",
  );
  const currentBody =
    bodyIndex >= 0 && base[bodyIndex] && typeof base[bodyIndex] === "object"
      ? (base[bodyIndex] as Record<string, unknown>)
      : null;
  const nextBody = {
    ...(currentBody || {}),
    type: "BODY",
    text: bodyText,
  };

  if (bodyIndex >= 0) {
    return base.map((component, index) =>
      index === bodyIndex ? nextBody : component,
    );
  }

  return [...base, nextBody];
}

function buildTemplateLookupFilter(params: {
  workspaceId: string;
  templateId: string | null;
  templateName: string;
  templateLanguage: string | null;
}) {
  const filter: Record<string, unknown> = { workspaceId: params.workspaceId };
  if (params.templateId) {
    filter.templateId = params.templateId;
  } else {
    filter.name = params.templateName;
    if (params.templateLanguage) filter.language = params.templateLanguage;
  }
  return filter;
}

export function createWhatsAppTemplateLifecycleHandlers(
  deps: TemplateLifecycleDependencies,
) {
  return {
    handleTemplateCategoryUpdate: async (params: {
      wabaId: string;
      value: TemplateCategoryUpdateValue;
    }): Promise<void> => {
      await deps.connectDB();

      const previousCategory = (
        params.value.previous_category || ""
      ).toUpperCase();
      const newCategory = (
        params.value.new_category ||
        params.value.correct_category ||
        ""
      ).toUpperCase();
      const templateName = params.value.message_template_name;
      const templateLanguage = params.value.message_template_language || null;
      const templateId = normalizeTemplateId(params.value.message_template_id);

      if (!newCategory || !templateName) {
        deps.logger.warn("template_category_update skipped (missing fields)", {
          wabaId: params.wabaId,
          newCategory,
          hasName: Boolean(templateName),
        });
        return;
      }

      const workspaces = await findWorkspacesForWaba(deps, params.wabaId);
      if (workspaces.length === 0) return;

      for (const ws of workspaces) {
        if (isPersistableCategory(newCategory)) {
          const overrides: Record<string, unknown> = {
            category: newCategory,
          };
          if (isPersistableCategory(previousCategory)) {
            overrides.previous_category = previousCategory;
          }
          const set = { ...overrides, lastSyncedAt: deps.now() };
          try {
            await deps.updateTemplateSnapshot({
              filter: buildTemplateLookupFilter({
                workspaceId: ws.workspaceId,
                templateId,
                templateName,
                templateLanguage,
              }),
              set,
            });
          } catch (error) {
            deps.logger.warn(
              "template_category_update: snapshot update failed",
              {
                workspaceId: ws.workspaceId,
                templateName,
                newCategory,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
          const refreshed = await refreshMirrors(deps, {
            kind: "template_category_update",
            keepStoredStatus: true,
            overrides,
            source: ws,
            templateId,
            templateName,
            wabaId: params.wabaId,
          });
          await patchCatalog(deps, {
            workspaceId: ws.workspaceId, sourceId: ws.id, wabaId: params.wabaId,
            templateId: templateId ?? undefined, name: templateName,
            language: templateLanguage ?? undefined,
            patch: { ...catalogMirrorPatch(refreshed), ...overrides },
          });
        }

        await writeAudit(deps, {
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          changes: {
            previous_category: previousCategory || null,
            new_category: newCategory,
            kind: "category_update",
          },
        });

        const isPriceRelevantFlip =
          previousCategory &&
          newCategory &&
          previousCategory !== newCategory &&
          (newCategory === "MARKETING" || previousCategory === "MARKETING");

        if (!isPriceRelevantFlip) continue;

        const gotMoreExpensive = newCategory === "MARKETING";
        await deps.publishWorkspaceAlert({
          workspaceId: ws.workspaceId,
          type: gotMoreExpensive ? "critical" : "warning",
          title: `Template "${templateName}" re-categorised ${previousCategory} -> ${newCategory}`,
          message: gotMoreExpensive
            ? "Meta reclassified this template as MARKETING, which is billed at the higher marketing rate. Open the template to appeal or adjust the copy."
            : "Meta reclassified this template. Review the new category.",
          dedupeKey: `whatsapp:template:${templateName}:${templateLanguage || "*"}:category:${newCategory}`,
          action: {
            label: "Open templates",
            url: `/panel/w/${ws.workspaceId}/messengers/whatsapp-templates`,
          },
          metadata: {
            templateId,
            templateName,
            templateLanguage,
            previousCategory: previousCategory || null,
            newCategory,
          },
        });

        deps.logger.info("template_category_update processed", {
          workspaceId: ws.workspaceId,
          templateName,
          templateLanguage,
          previousCategory: previousCategory || null,
          newCategory,
        });
      }
    },

    handleTemplateComponentsUpdate: async (params: {
      wabaId: string;
      value: TemplateComponentsUpdateValue;
    }): Promise<void> => {
      await deps.connectDB();

      const templateName = params.value.message_template_name;
      const templateLanguage = params.value.message_template_language || null;
      const templateId = normalizeTemplateId(params.value.message_template_id);
      const bodyText =
        typeof params.value.message_template_element === "string"
          ? params.value.message_template_element
          : null;

      if (!templateName) {
        deps.logger.warn(
          "template_components_update skipped (missing fields)",
          {
            wabaId: params.wabaId,
            hasName: Boolean(templateName),
            templateId,
          },
        );
        return;
      }

      const workspaces = await findWorkspacesForWaba(deps, params.wabaId);
      if (workspaces.length === 0) {
        deps.logger.warn(
          "template_components_update: no workspace found for WABA",
          {
            wabaId: params.wabaId,
            templateId,
            templateName,
          },
        );
        return;
      }

      for (const ws of workspaces) {
        const filter = buildTemplateLookupFilter({
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          templateLanguage,
        });
        const existing = await deps.findTemplateSnapshot(filter);
        // The webhook names only the body text; buttons, header and footer
        // changes are read from Meta.
        const refreshed = await refreshMirrors(deps, {
          kind: "template_components_update",
          keepStoredStatus: true,
          source: ws,
          templateId,
          templateName,
          wabaId: params.wabaId,
        });
        const previousBodyText = readBodyText(existing?.components);
        const nextBodyText = refreshed
          ? readBodyText(refreshed.components)
          : bodyText;

        if (!refreshed && existing) {
          try {
            await deps.updateTemplateSnapshot({
              filter: { _id: existing._id },
              set: {
                components: patchBodyComponent(existing.components, bodyText),
                lastSyncedAt: deps.now(),
              },
            });
          } catch (error) {
            deps.logger.warn(
              "template_components_update: snapshot update failed",
              {
                workspaceId: ws.workspaceId,
                templateId,
                templateName,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        } else if (!refreshed) {
          deps.logger.warn(
            "template_components_update: local snapshot not found",
            {
              workspaceId: ws.workspaceId,
              templateId,
              templateName,
              templateLanguage,
            },
          );
        }

        if (refreshed || bodyText !== null) {
          await patchCatalog(deps, {
            workspaceId: ws.workspaceId, sourceId: ws.id, wabaId: params.wabaId,
            templateId: templateId ?? undefined, name: templateName,
            language: templateLanguage ?? undefined,
            patch: refreshed ? catalogMirrorPatch(refreshed) : current => ({
              components: patchBodyComponent(current.components, bodyText) as WhatsAppTemplate["components"],
            }),
          });
        }

        await writeAudit(deps, {
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          changes: {
            kind: "components_update",
            templateLanguage,
            // Unknown (null) without both texts to compare.
            bodyTextChanged:
              previousBodyText !== null && nextBodyText !== null
                ? nextBodyText !== previousBodyText
                : null,
            refreshedFromMeta: Boolean(refreshed),
            raw: params.value,
          },
        });

        deps.logger.info("template_components_update processed", {
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          templateLanguage,
          updatedSnapshot: refreshed
            ? Boolean(refreshed.snapshotUpdated)
            : Boolean(existing),
          refreshedFromMeta: Boolean(refreshed),
        });
      }
    },

    handleTemplateQualityUpdate: async (params: {
      wabaId: string;
      value: TemplateQualityUpdateValue;
    }): Promise<void> => {
      await deps.connectDB();

      const previousQuality = (
        params.value.previous_quality_score || ""
      ).toUpperCase();
      const newQuality = (params.value.new_quality_score || "").toUpperCase();
      const templateName = params.value.message_template_name;
      const templateLanguage = params.value.message_template_language || null;
      const templateId = normalizeTemplateId(params.value.message_template_id);

      if (!newQuality || !templateName) {
        deps.logger.warn("template_quality_update skipped (missing fields)", {
          wabaId: params.wabaId,
          newQuality,
          hasName: Boolean(templateName),
        });
        return;
      }

      const workspaces = await findWorkspacesForWaba(deps, params.wabaId);
      if (workspaces.length === 0) {
        deps.logger.warn(
          "template_quality_update: no workspace found for WABA",
          {
            wabaId: params.wabaId,
            templateName,
            newQuality,
          },
        );
        return;
      }

      for (const ws of workspaces) {
        if (isPersistableQuality(newQuality)) {
          try {
            await deps.updateTemplateSnapshot({
              filter: buildTemplateLookupFilter({
                workspaceId: ws.workspaceId,
                templateId,
                templateName,
                templateLanguage,
              }),
              set: { quality_rating: newQuality, lastSyncedAt: deps.now() },
            });
          } catch (error) {
            deps.logger.warn(
              "template_quality_update: snapshot update failed",
              {
                workspaceId: ws.workspaceId,
                templateName,
                newQuality,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
          await patchCatalog(deps, {
            workspaceId: ws.workspaceId, sourceId: ws.id, wabaId: params.wabaId,
            templateId: templateId ?? undefined, name: templateName,
            language: templateLanguage ?? undefined,
            patch: { quality_rating: newQuality },
          });
        }

        await writeAudit(deps, {
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          changes: {
            previous_quality: previousQuality || null,
            new_quality: newQuality,
            kind: "quality_update",
          },
        });

        const isDegradation =
          newQuality === "RED" ||
          (newQuality === "YELLOW" && previousQuality === "GREEN");

        if (!isDegradation) continue;

        await deps.publishWorkspaceAlert({
          workspaceId: ws.workspaceId,
          type: newQuality === "RED" ? "critical" : "warning",
          title:
            newQuality === "RED"
              ? `Template "${templateName}" quality dropped to RED`
              : `Template "${templateName}" quality degraded to ${newQuality}`,
          message:
            newQuality === "RED"
              ? "Customers are marking messages with this template as spam. Pause the broadcast and revise the copy before Meta auto-pauses it."
              : "Monitor this template - continued degradation will lead to Meta pausing it automatically.",
          dedupeKey: `whatsapp:template:${templateName}:${templateLanguage || "*"}:quality:${newQuality}`,
          action: {
            label: "Open templates",
            url: `/panel/w/${ws.workspaceId}/messengers/whatsapp-templates`,
          },
          metadata: {
            templateId,
            templateName,
            templateLanguage,
            previousQuality: previousQuality || null,
            newQuality,
          },
        });

        deps.logger.info("template_quality_update processed", {
          workspaceId: ws.workspaceId,
          templateName,
          templateLanguage,
          previousQuality: previousQuality || null,
          newQuality,
        });
      }
    },

    handleTemplateStatusUpdate: async (params: {
      wabaId: string;
      value: TemplateStatusUpdateValue;
    }): Promise<void> => {
      await deps.connectDB();

      const event = (params.value.event || "").toUpperCase();
      const templateName = params.value.message_template_name;
      const templateLanguage = params.value.message_template_language || null;
      const templateId = normalizeTemplateId(params.value.message_template_id);

      if (!event || !templateName) {
        deps.logger.warn("template_status_update skipped (missing fields)", {
          wabaId: params.wabaId,
          event,
          hasName: Boolean(templateName),
        });
        return;
      }

      const workspaces = await findWorkspacesForWaba(deps, params.wabaId);
      if (workspaces.length === 0) {
        deps.logger.warn(
          "template_status_update: no workspace found for WABA",
          {
            wabaId: params.wabaId,
            templateName,
            event,
          },
        );
        return;
      }

      for (const ws of workspaces) {
        if (isPersistableStatus(event)) {
          const overrides: Record<string, unknown> = {
            status: event,
          };
          if (params.value.reason) {
            overrides.rejected_reason = params.value.reason;
          }
          if (isPersistableCategory(params.value.new_category)) {
            overrides.category = params.value.new_category;
          }
          if (isPersistableCategory(params.value.previous_category)) {
            overrides.previous_category = params.value.previous_category;
          }
          const set = { ...overrides, lastSyncedAt: deps.now() };

          try {
            await deps.updateTemplateSnapshot({
              filter: buildTemplateLookupFilter({
                workspaceId: ws.workspaceId,
                templateId,
                templateName,
                templateLanguage,
              }),
              set,
            });
          } catch (error) {
            deps.logger.warn("template_status_update: snapshot update failed", {
              workspaceId: ws.workspaceId,
              templateName,
              templateLanguage,
              event,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // Meta can still report the earlier status for a moment, so the
          // event's status wins over the one read back.
          const refreshed = await refreshMirrors(deps, {
            kind: "template_status_update",
            keepStoredStatus: false,
            overrides,
            source: ws,
            templateId,
            templateName,
            wabaId: params.wabaId,
          });
          await patchCatalog(deps, {
            workspaceId: ws.workspaceId, sourceId: ws.id, wabaId: params.wabaId,
            templateId: templateId ?? undefined, name: templateName,
            language: templateLanguage ?? undefined,
            patch: { ...catalogMirrorPatch(refreshed), ...overrides },
          });
        } else if (UNUSABLE_STATUSES.has(event)) {
          await patchCatalog(deps, {
            workspaceId: ws.workspaceId, sourceId: ws.id, wabaId: params.wabaId,
            templateId: templateId ?? undefined, name: templateName,
            language: templateLanguage ?? undefined, patch: {}, remove: true,
          });
        }

        let retiredCount = 0;
        if (UNUSABLE_STATUSES.has(event)) {
          try {
            retiredCount = await deps.retirePendingCampaignTasks({
              workspaceId: ws.workspaceId,
              templateName,
              templateLanguage,
              reason: `template_${event.toLowerCase()}${
                params.value.reason ? `:${params.value.reason}` : ""
              }`,
            });
          } catch (error) {
            deps.logger.warn("template_status_update: campaign retire failed", {
              workspaceId: ws.workspaceId,
              templateName,
              event,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        await writeAudit(deps, {
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          changes: {
            event,
            reason: params.value.reason ?? null,
            previous_category: params.value.previous_category ?? null,
            new_category: params.value.new_category ?? null,
            retiredCampaignTasks: retiredCount,
            kind: "status_update",
          },
        });

        const severity: WorkspaceAlertSeverity =
          event === "APPROVED"
            ? "info"
            : UNUSABLE_STATUSES.has(event)
              ? "critical"
              : "warning";

        const title =
          event === "APPROVED"
            ? `Template "${templateName}" approved`
            : event === "REJECTED"
              ? `Template "${templateName}" rejected by Meta`
              : event === "PAUSED"
                ? `Template "${templateName}" paused by Meta`
                : event === "FLAGGED"
                  ? `Template "${templateName}" flagged by Meta`
                  : event === "DISABLED"
                    ? `Template "${templateName}" disabled`
                    : event === "PENDING_DELETION"
                      ? `Template "${templateName}" pending deletion`
                      : `Template "${templateName}" status: ${event}`;

        const reasonSuffix = params.value.reason
          ? ` (${params.value.reason})`
          : "";
        const retiredSuffix = retiredCount
          ? ` - ${retiredCount} pending send${retiredCount === 1 ? "" : "s"} cancelled.`
          : "";
        const message = `${templateLanguage ? `[${templateLanguage}] ` : ""}${
          event === "APPROVED"
            ? "You can use it in campaigns."
            : UNUSABLE_STATUSES.has(event)
              ? `This template can't be used until you fix it${reasonSuffix}.${retiredSuffix}`
              : `Review the template${reasonSuffix}.`
        }`;

        await deps.publishWorkspaceAlert({
          workspaceId: ws.workspaceId,
          type: severity,
          title,
          message,
          dedupeKey: `whatsapp:template:${templateName}:${templateLanguage || "*"}:${event}`,
          action: {
            label: "Open templates",
            url: `/panel/w/${ws.workspaceId}/messengers/whatsapp-templates`,
          },
          metadata: {
            templateId,
            templateName,
            templateLanguage,
            event,
            reason: params.value.reason ?? null,
            retiredCampaignTasks: retiredCount,
          },
        });

        deps.logger.info("template_status_update processed", {
          workspaceId: ws.workspaceId,
          templateId,
          templateName,
          templateLanguage,
          event,
          retiredCampaignTasks: retiredCount,
        });
      }
    },
  };
}
