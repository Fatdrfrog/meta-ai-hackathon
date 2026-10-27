/**
 * Submit the reviewed airi.chat public demos through the normal template owners.
 * Run from apps/web with --conditions=react-server and the normal server env.
 * Default: validate and read provider state. --apply authorizes new submissions.
 * --refresh-receipt writes local proof/bindings only after the reviewed batch matches.
 * --audit-report <file> validates one live inventory without provider/mirror mutations.
 * --defer-created-status-readback requires --apply and full final batch mirror proof.
 * A receipt fences uncertain creates; an accepted Meta template is never recreated.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const IDENTITY = {
  email: "samat@airi.chat",
  userId: "7489e157-423e-48a8-80fb-4963e2767691",
  workspaceId: "41b51d55-697c-4455-875a-9a7238bdf272",
  companyId: "d81123b4-b2fa-49d3-86af-25b4482b8269",
  sourceId: "7b1b9051-ba18-46d0-b345-4caf0d5e40b2",
  wabaId: "1004068288935896",
  phoneNumberId: "1279998868523616",
} as const;

type Component = Record<string, unknown> & { type: string; text?: string };
type ProviderTemplate = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: Component[];
};
type Variant = {
  key: string;
  catalogId: string;
  locale: "en" | "ru" | "kz";
  language: "en" | "ru" | "kk";
  payload: {
    name: string;
    language: string;
    category: "MARKETING";
    components: Component[];
  };
  bindingDraft: Record<string, unknown>;
  expectedTemplateId?: string;
  previousComponents?: Component[];
};
type FlowDefinition = {
  catalogId: string;
  name: string;
  language: Variant["language"];
  publicLocale: Variant["locale"];
  entryScreen: string;
  categories: string[];
  endpointRequired: boolean;
  personalFields: string[];
  flowJson: Record<string, unknown>;
};
type ReviewedPlan = {
  variants: Variant[];
  expectedVariantCount?: number;
  flowDefinitions?: FlowDefinition[];
};
type ReceiptEntry = {
  name: string;
  language: string;
  state: string;
  startedAt?: string;
  templateId?: string;
  recordId?: string;
  status?: string;
  error?: string;
  updateStartedAt?: string;
};
type Receipt = { entries: Record<string, ReceiptEntry> };
type FlowReceiptEntry = {
  flowId?: string;
  startedAt?: string;
  status?: string;
  verified?: boolean;
  entryScreen?: string;
  error?: string;
  mutationStartedAt?: string;
  mutationOperation?: "update_json" | "publish";
};

const operatorSecrets = new Set(
  Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /TOKEN|SECRET|KEY|PASSWORD|MONGODB_URI/.test(name) && value
    )
    .map(([, value]) => value as string)
);

export function operatorErrorMessage(
  error: unknown,
  secrets: readonly string[]
) {
  let message =
    error instanceof Error ? error.message : "Template operation failed";
  for (const secret of secrets.filter(Boolean)) {
    message = message.replaceAll(secret, "[redacted]");
    message = message.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return message
    .replace(/(access_token=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]");
}

export function reconciliationEntry(
  previous: ReceiptEntry,
  error: unknown,
  secrets: readonly string[]
): ReceiptEntry {
  const failure = error as {
    metaTemplateId?: string;
    metaTemplateStatus?: string;
  } | null;
  return {
    ...previous,
    state: "needs_reconciliation",
    templateId: failure?.metaTemplateId ?? previous.templateId,
    status: failure?.metaTemplateStatus ?? previous.status,
    error: operatorErrorMessage(error, secrets),
  };
}

export function verifiedReceiptEntry(
  previous: ReceiptEntry | undefined,
  template: Pick<ProviderTemplate, "id" | "name" | "language" | "status">,
  recordId?: string
): ReceiptEntry {
  return {
    ...previous,
    name: template.name,
    language: template.language,
    state: "verified",
    templateId: template.id,
    status: template.status,
    ...(recordId ? { recordId } : {}),
  };
}

const FENCED_TEMPLATE_STATES = new Set([
  "submitting",
  "accepted",
  "verified",
  "needs_reconciliation",
]);

export function hasTemplateCreationFence(
  entry: ReceiptEntry | undefined
): boolean {
  return Boolean(
    entry &&
      (entry.startedAt ||
        entry.templateId ||
        FENCED_TEMPLATE_STATES.has(entry.state))
  );
}

export function hasTemplateUpdateFence(
  entry: ReceiptEntry | undefined
): boolean {
  return Boolean(
    entry &&
      (entry.updateStartedAt ||
        entry.state === "updating" ||
        entry.state === "needs_reconciliation")
  );
}

export function hasDemoMutationBudget(
  createdCount: number,
  editedCount: number,
  limit: number
): boolean {
  return createdCount + editedCount < limit;
}

export function hasFlowMutationFence(
  entry: FlowReceiptEntry | undefined
): boolean {
  return Boolean(
    entry &&
      (entry.mutationStartedAt ||
        entry.mutationOperation ||
        ["uploading", "publishing", "needs_reconciliation"].includes(
          entry.status || ""
        ))
  );
}

export function requiresRecoveredTemplateMirror(
  entry: ReceiptEntry | undefined
): boolean {
  return Boolean(
    entry && (entry.updateStartedAt || entry.state === "needs_reconciliation")
  );
}

export function assertTemplateMirrorResult(result: { errors: string[] }): void {
  if (result.errors.length)
    throw new Error(
      "Mirror reconciliation failed; provider template must not be edited again"
    );
}

export function requireTemplateUpdateSnapshot(result: {
  success: boolean;
  template?: ProviderTemplate;
}): ProviderTemplate {
  if (!result.success || !result.template)
    throw new Error(
      "Accepted edit readback requires reconciliation; do not retry the edit"
    );
  return result.template;
}

export function assertDeferredCreatedStatusOptions(options: {
  deferCreatedStatusReadback: boolean;
  apply: boolean;
  refreshReceipt: boolean;
  editExisting: boolean;
  publishFlows: boolean;
  auditReport?: boolean;
}): void {
  if (
    options.auditReport &&
    (options.apply ||
      options.refreshReceipt ||
      options.editExisting ||
      options.publishFlows ||
      options.deferCreatedStatusReadback)
  )
    throw new Error(
      "Inventory audit is read-only and cannot combine with mutation or receipt modes"
    );
  if (
    options.deferCreatedStatusReadback &&
    (!options.apply ||
      options.refreshReceipt ||
      options.editExisting ||
      options.publishFlows)
  ) {
    throw new Error(
      "Deferred created status readback requires a separate --apply creation phase"
    );
  }
}

/** Final readback uses the batch snapshot; local proof never issues another Graph GET. */
export async function verifyTemplateBatchSnapshots(options: {
  variants: Variant[];
  templates: ReadonlyMap<string, ProviderTemplate>;
  entries: Receipt["entries"];
  apply: boolean;
  editExisting: boolean;
  requireComplete: boolean;
  mirrorAndVerify?: (
    template: ProviderTemplate,
    rowId: string,
    variant: Variant
  ) => Promise<void>;
}): Promise<{
  bindings: Record<string, unknown>[];
  entries: Receipt["entries"];
}> {
  if (options.apply && !options.mirrorAndVerify)
    throw new Error("Final apply requires local mirror proof");
  const matches: { variant: Variant; template: ProviderTemplate }[] = [];
  for (const variant of options.variants) {
    const template = options.templates.get(
      providerTemplateKey(variant.payload.name, variant.language)
    );
    if (!template) continue;
    if (
      getTemplateReconciliationAction(
        template,
        variant,
        options.editExisting
      ) === "edit"
    )
      continue;
    if (
      options.entries[variant.key]?.templateId &&
      options.entries[variant.key].templateId !== template.id
    )
      throw new Error(`Acknowledged template ID mismatch: ${variant.key}`);
    if (options.apply && !options.entries[variant.key]?.recordId)
      throw new Error(
        `Local record ownership requires reconciliation: ${variant.key}`
      );
    matches.push({ variant, template });
  }
  if (options.requireComplete && matches.length !== options.variants.length)
    throw new Error(
      "Final readback requires the complete reviewed batch before bindings"
    );
  const entries = { ...options.entries };
  const bindings: Record<string, unknown>[] = [];
  for (const { variant, template } of matches) {
    if (options.apply)
      await options.mirrorAndVerify!(
        template,
        entries[variant.key].recordId!,
        variant
      );
    entries[variant.key] = verifiedReceiptEntry(entries[variant.key], template);
    bindings.push({
      ...variant.bindingDraft,
      templateId: template.id,
      templateName: template.name,
      language: template.language,
    });
  }
  return { bindings, entries };
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} needs a value`);
  return value;
}

export async function assertAuditReportOutputPath(
  reportPath: string,
  reservedPaths: string[]
): Promise<void> {
  const normalize = (path: string) => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  if (reservedPaths.some(path => normalize(path) === normalize(reportPath)))
    throw new Error(
      "Audit output path is reserved for review or recovery evidence"
    );
  try {
    await stat(reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Audit output already exists; choose a fresh report path");
}

const importWeb = (path: string) =>
  import(pathToFileURL(join(process.cwd(), "src", path)).href);

export function validateReviewedBatch(plan: ReviewedPlan): number {
  // Preserve the original multilingual manifest; new batches declare their size.
  const expected = plan.expectedVariantCount ?? 36;
  if (
    !Number.isInteger(expected) ||
    expected < 1 ||
    expected > 250 ||
    !Array.isArray(plan.variants) ||
    plan.variants.length !== expected ||
    new Set(plan.variants.map(variant => variant.key)).size !== expected ||
    new Set(plan.variants.map(variant => variant.payload.name)).size !==
      expected
  )
    throw new Error(
      "Expected the complete, unique reviewed demo batch (1..250)"
    );
  const content = plan.variants.map(variant =>
    providerContentKey(
      variant.language,
      variant.payload.components,
      variant.payload.category
    )
  );
  if (new Set(content).size !== content.length)
    throw new Error("Duplicate reviewed content in the same language");
  return expected;
}

function normalizeProviderComponent(value: unknown, key?: string): unknown {
  // Meta's readback replaces review upload handles with its own CDN samples.
  // Those samples are not the stable media URLs used by delivery bindings.
  if (key === "flow_id") return String(value);
  if (typeof value === "string") {
    const text = value.normalize("NFC").replace(/[\u00a0\u202f]/g, " ");
    return key === "flow_action" ? text.toUpperCase() : text;
  }
  if (Array.isArray(value))
    return value.map(item => normalizeProviderComponent(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => name !== "example")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, normalizeProviderComponent(item, name)])
    );
  }
  return value;
}

function providerContentKey(
  language: string,
  components: Component[],
  category?: string
): string {
  return JSON.stringify([
    language,
    category ?? null,
    normalizeProviderComponent(components),
  ]);
}

export function assertNoDuplicateProviderContent(
  templates: ProviderTemplate[],
  variant: Variant
): void {
  const expected = providerContentKey(
    variant.language,
    variant.payload.components,
    variant.payload.category
  );
  const duplicate = templates.find(
    template =>
      template.name !== variant.payload.name &&
      providerContentKey(
        template.language,
        template.components,
        template.category
      ) === expected
  );
  if (duplicate)
    throw new Error(
      `Existing provider content requires reuse or review: ${variant.key} / ${duplicate.id}`
    );
}

export function providerTemplateKey(name: string, language: string): string {
  return `${name}:${language}`;
}

export function indexProviderTemplates(templates: ProviderTemplate[]) {
  const indexed = new Map<string, ProviderTemplate>();
  for (const template of templates) {
    const key = providerTemplateKey(template.name, template.language);
    if (indexed.has(key))
      throw new Error(`Duplicate provider identity: ${key}`);
    indexed.set(key, template);
  }
  return indexed;
}

/** Template-only report: no tokens, recipient data, media handles or mutations. */
export function auditProviderTemplateSnapshot(
  templates: ProviderTemplate[],
  variants: Variant[]
) {
  const indexed = indexProviderTemplates(templates);
  const missing: string[] = [];
  const mismatched: string[] = [];
  const boundIds = new Set<string>();
  let matched = 0;
  for (const variant of variants) {
    const template = indexed.get(
      providerTemplateKey(variant.payload.name, variant.language)
    );
    if (!template) {
      missing.push(variant.key);
      continue;
    }
    boundIds.add(template.id);
    try {
      if (
        variant.expectedTemplateId &&
        template.id !== variant.expectedTemplateId
      )
        throw new Error("Unexpected provider ID");
      const binding = variant.bindingDraft;
      if (
        (typeof binding.templateId === "string" &&
          /^\d+$/.test(binding.templateId) &&
          binding.templateId !== template.id) ||
        (typeof binding.templateName === "string" &&
          /^[a-z0-9_]+$/.test(binding.templateName) &&
          binding.templateName !== template.name) ||
        (typeof binding.language === "string" &&
          /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(binding.language) &&
          binding.language !== template.language)
      )
        throw new Error("Frozen binding identity mismatch");
      assertProviderIdentity(template, variant);
      matched++;
    } catch {
      mismatched.push(variant.key);
    }
  }
  const contentGroups = new Map<string, string[]>();
  const crossCategoryGroups = new Map<
    string,
    { id: string; category: string }[]
  >();
  const categories: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const identity = templates.map(template => {
    const fingerprint = providerContentKey(
      template.language,
      template.components,
      template.category
    );
    const ids = contentGroups.get(fingerprint) ?? [];
    ids.push(template.id);
    contentGroups.set(fingerprint, ids);
    const acrossCategoryKey = providerContentKey(
      template.language,
      template.components
    );
    const acrossCategory = crossCategoryGroups.get(acrossCategoryKey) ?? [];
    acrossCategory.push({ id: template.id, category: template.category });
    crossCategoryGroups.set(acrossCategoryKey, acrossCategory);
    categories[template.category] = (categories[template.category] ?? 0) + 1;
    statuses[template.status] = (statuses[template.status] ?? 0) + 1;
    return {
      id: template.id,
      name: template.name,
      language: template.language,
      category: template.category,
      status: template.status,
    };
  });
  return {
    total: templates.length,
    expected: variants.length,
    matched,
    missing,
    mismatched,
    categories,
    statuses,
    duplicateContent: [...contentGroups.values()].filter(ids => ids.length > 1),
    crossCategoryOverlap: [...crossCategoryGroups.values()]
      .filter(items => new Set(items.map(item => item.category)).size > 1)
      .map(items => items.map(item => item.id)),
    unbound: identity.filter(template => !boundIds.has(template.id)),
    templates: identity,
  };
}

export function assertProviderIdentity(
  template: ProviderTemplate,
  variant: Variant
) {
  if (
    !/^\d+$/.test(template.id) ||
    template.name !== variant.payload.name ||
    template.language !== variant.language ||
    template.category !== "MARKETING" ||
    JSON.stringify(normalizeProviderComponent(template.components)) !==
      JSON.stringify(normalizeProviderComponent(variant.payload.components))
  )
    throw new Error(`Provider identity/content mismatch: ${variant.key}`);
}

export function getTemplateReconciliationAction(
  template: ProviderTemplate,
  variant: Variant,
  editExisting: boolean
): "reuse" | "edit" {
  if (variant.expectedTemplateId && template.id !== variant.expectedTemplateId)
    throw new Error(`Unexpected existing template ID: ${variant.key}`);
  try {
    assertProviderIdentity(template, variant);
    return "reuse";
  } catch (error) {
    if (!editExisting) throw error;
  }
  if (!variant.expectedTemplateId || !variant.previousComponents)
    throw new Error(
      `Editing requires the reviewed original ID and components: ${variant.key}`
    );
  assertProviderIdentity(template, {
    ...variant,
    payload: { ...variant.payload, components: variant.previousComponents },
  });
  return "edit";
}

export function assertReviewedDemoFlow(definition: FlowDefinition): void {
  const expected = `airi_demo_${definition.catalogId.replaceAll("-", "_")}_${definition.language}_v1`;
  const screens = definition.flowJson.screens as
    | { id?: string; terminal?: boolean }[]
    | undefined;
  if (
    definition.name !== expected ||
    { en: "en", ru: "ru", kz: "kk" }[definition.publicLocale] !==
      definition.language ||
    definition.endpointRequired ||
    definition.personalFields.length ||
    !Array.isArray(screens) ||
    !screens.some(screen => screen.id === definition.entryScreen) ||
    !screens.some(screen => screen.terminal) ||
    definition.flowJson.data_api_version ||
    JSON.stringify(definition.flowJson).includes('"data_exchange"')
  )
    throw new Error(`Unexpected endpointless demo Flow: ${definition.name}`);
}

async function publishReviewedFlows(
  plan: ReviewedPlan,
  account: { accessToken: string; wabaId: string },
  receiptPath: string,
  apply: boolean
) {
  const definitions = plan.flowDefinitions;
  if (
    !definitions?.length ||
    definitions.length > 50 ||
    new Set(definitions.map(flow => flow.name)).size !== definitions.length
  )
    throw new Error("Expected a complete unique reviewed Flow batch");
  const flows = await importWeb("lib/whatsapp/flows/service.ts");
  const path = receiptPath.replace(/\.json$/, ".flows.json");
  let receipt: Record<string, FlowReceiptEntry> = {};
  try {
    receipt = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const persist = () =>
    writeFile(path, JSON.stringify(receipt, null, 2) + "\n");
  const stableJson = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
          )
        : item
    );
  for (const definition of definitions) assertReviewedDemoFlow(definition);
  for (const definition of definitions) {
    const found = await flows.findMetaWhatsAppFlowByExactName({
      ...account,
      name: definition.name,
    });
    if (!found.ok) throw new Error(found.error || "Flow lookup failed");
    let flow = found.flow;
    let flowId = String(flow?.id || "");
    const prior = receipt[definition.name];
    if (prior?.flowId && flowId !== prior.flowId)
      throw new Error(
        `Flow receipt/provider identity mismatch: ${definition.name}`
      );
    if (!apply) {
      console.log(
        JSON.stringify({
          flow: definition.name,
          id: flowId || null,
          status: flow?.status || "missing",
          action: "validated",
        })
      );
      continue;
    }
    if (!flowId) {
      if (prior?.startedAt)
        throw new Error(`Uncertain prior Flow creation: ${definition.name}`);
      receipt[definition.name] = {
        startedAt: new Date().toISOString(),
        status: "creating",
        entryScreen: definition.entryScreen,
      };
      await persist();
      const created = await flows.createMetaWhatsAppFlow({
        ...account,
        name: definition.name,
        categories: definition.categories,
      });
      flowId = String(created.flow?.id || created.providerFlowId || "");
      receipt[definition.name] = {
        ...receipt[definition.name],
        flowId: flowId || undefined,
        status: created.flow?.status || "needs_reconciliation",
      };
      await persist();
      if (!created.ok || !flowId)
        throw new Error(
          created.error || "Flow create outcome needs reconciliation"
        );
      flow = created.flow;
    } else if (flow?.status === "DRAFT" && prior?.flowId !== flowId) {
      throw new Error(
        `Existing draft needs reviewed ownership evidence: ${definition.name}`
      );
    }
    try {
      if (flow?.status === "DRAFT") {
        if (hasFlowMutationFence(receipt[definition.name]))
          throw new Error(`Uncertain prior Flow mutation: ${definition.name}`);
        receipt[definition.name] = {
          ...receipt[definition.name],
          status: "uploading",
          mutationOperation: "update_json",
          mutationStartedAt: new Date().toISOString(),
        };
        await persist();
        const uploaded = await flows.updateMetaWhatsAppFlow({
          accessToken: account.accessToken,
          flowId,
          operation: "update_json",
          flowJson: JSON.stringify(definition.flowJson),
        });
        if (
          !uploaded.ok ||
          uploaded.validation_errors?.length ||
          uploaded.flow?.validation_errors?.length
        )
          throw new Error(uploaded.error || "Flow JSON validation failed");
        receipt[definition.name] = {
          ...receipt[definition.name],
          status: "publishing",
          mutationOperation: "publish",
          mutationStartedAt: new Date().toISOString(),
        };
        await persist();
        const published = await flows.updateMetaWhatsAppFlow({
          accessToken: account.accessToken,
          flowId,
          operation: "publish",
        });
        if (!published.ok || published.flow?.status !== "PUBLISHED")
          throw new Error(published.error || "Flow publication not confirmed");
      } else if (flow?.status !== "PUBLISHED")
        throw new Error("Unexpected Flow status");
      const verified = await flows.getMetaWhatsAppFlow({
        accessToken: account.accessToken,
        flowId,
        expectedWabaId: account.wabaId,
        includeJson: true,
      });
      const decoded =
        typeof verified.flowJson === "string"
          ? JSON.parse(verified.flowJson)
          : verified.flowJson;
      if (
        !verified.ok ||
        verified.flow?.status !== "PUBLISHED" ||
        verified.flow?.validation_errors?.length ||
        stableJson(decoded) !== stableJson(definition.flowJson)
      )
        throw new Error(
          verified.error || "Published Flow differs from reviewed content"
        );
      receipt[definition.name] = {
        ...receipt[definition.name],
        flowId,
        status: "PUBLISHED",
        entryScreen: definition.entryScreen,
        verified: true,
        mutationOperation: undefined,
        mutationStartedAt: undefined,
      };
      await persist();
      console.log(
        JSON.stringify({
          flow: definition.name,
          id: flowId,
          status: "PUBLISHED",
          verified: true,
        })
      );
    } catch (error) {
      receipt[definition.name] = {
        ...receipt[definition.name],
        error: operatorErrorMessage(error, [...operatorSecrets]),
        verified: false,
      };
      await persist();
      throw new Error(operatorErrorMessage(error, [...operatorSecrets]));
    }
  }
}

async function main() {
  const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
  if (packageInfo.name !== "@icecore/web") throw new Error("Run from apps/web");
  // The production project (Frankfurt since 2026-10-26), by its host or its
  // custom domain. The old Singapore project is read-only.
  if (
    !["eufcprvswhmkgzkmwxxs.supabase.co", "api.airi.chat"].includes(
      new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").hostname
    )
  )
    throw new Error("Wrong Supabase project");
  const manifestPath = resolve(
    argument(
      "--manifest",
      "../../docs/integrations/public-whatsapp-template-gallery-submissions.json"
    )
  );
  const receiptPath = resolve(
    argument("--receipt", "public-template-submission-receipt.local.json")
  );
  const bindingsPath = receiptPath.replace(/\.json$/, ".bindings.json");
  if (bindingsPath === receiptPath)
    throw new Error("Receipt must end in .json");
  const plan = JSON.parse(await readFile(manifestPath, "utf8")) as ReviewedPlan;
  const expectedVariantCount = validateReviewedBatch(plan);
  const apply = process.argv.includes("--apply");
  const refreshReceipt = process.argv.includes("--refresh-receipt");
  const editExisting = process.argv.includes("--edit-existing");
  const publishFlows = process.argv.includes("--publish-flows");
  const deferCreatedStatusReadback = process.argv.includes(
    "--defer-created-status-readback"
  );
  const auditReportPath = process.argv.includes("--audit-report")
    ? resolve(argument("--audit-report", ""))
    : undefined;
  assertDeferredCreatedStatusOptions({
    deferCreatedStatusReadback,
    apply,
    refreshReceipt,
    editExisting,
    publishFlows,
    auditReport: Boolean(auditReportPath),
  });
  if (auditReportPath)
    await assertAuditReportOutputPath(auditReportPath, [
      manifestPath,
      receiptPath,
      bindingsPath,
      receiptPath.replace(/\.json$/, ".flows.json"),
    ]);
  if (apply && refreshReceipt)
    throw new Error("Use either --apply or --refresh-receipt");
  if (refreshReceipt && editExisting)
    throw new Error("Receipt refresh cannot edit templates");
  if (publishFlows && (editExisting || refreshReceipt))
    throw new Error("Flow publication is a separate batch phase");
  const maxCreates = Number(argument("--limit", String(expectedVariantCount)));
  if (
    !Number.isInteger(maxCreates) ||
    maxCreates < 1 ||
    maxCreates > expectedVariantCount
  )
    throw new Error(`--limit must be 1..${expectedVariantCount}`);
  const { supabaseAdmin } = await importWeb("lib/supabase/admin.ts");
  const { fetchSourceWithCredentialsResult } = await importWeb(
    "lib/sources/utils.ts"
  );
  const { normalizeWhatsAppCredentials } = await importWeb(
    "lib/whatsapp/credentials.ts"
  );
  const { parseWhatsAppTemplateSubmissionComponents } = await importWeb(
    "lib/whatsapp/templates/component-schemas.ts"
  );
  const { createUnifiedTemplateRecord } = await importWeb(
    "lib/whatsapp/templates/unified-service.ts"
  );
  const { updateWhatsAppTemplateMutation } = await importWeb(
    "lib/whatsapp/templates/mutation-service.ts"
  );
  const { mirrorWhatsAppTemplate } = await importWeb(
    "lib/whatsapp/templates/template-mirror.ts"
  );
  const { getWhatsAppGraphClient, collectMetaGraphEdge } = await import(
    pathToFileURL(resolve("../../packages/shared/src/lib/meta/api.ts")).href
  );
  const { data: user, error: userError } =
    await supabaseAdmin.auth.admin.getUserById(IDENTITY.userId);
  if (userError || user.user?.email !== IDENTITY.email)
    throw new Error("Wrong operator identity");
  const { data: membership, error: membershipError } = await supabaseAdmin
    .from("company_users")
    .select("role")
    .eq("user_id", IDENTITY.userId)
    .eq("workspace_id", IDENTITY.workspaceId)
    .single();
  const { data: workspace, error: workspaceError } = await supabaseAdmin
    .from("workspaces")
    .select("company_id")
    .eq("id", IDENTITY.workspaceId)
    .single();
  if (
    membershipError ||
    membership?.role !== "admin" ||
    workspaceError ||
    workspace?.company_id !== IDENTITY.companyId
  )
    throw new Error("Wrong Airi company/workspace membership");
  const source = await fetchSourceWithCredentialsResult(
    IDENTITY.sourceId,
    "whatsapp",
    { workspace_id: IDENTITY.workspaceId }
  );
  if (
    !source.ok ||
    !source.source ||
    source.source.company_id !== IDENTITY.companyId
  )
    throw new Error("Wrong Airi WhatsApp source");
  const credentials = normalizeWhatsAppCredentials(source.source.credentials);
  if (credentials.accessToken) operatorSecrets.add(credentials.accessToken);
  if (
    !credentials.accessToken ||
    credentials.wabaId !== IDENTITY.wabaId ||
    credentials.phoneNumberId !== IDENTITY.phoneNumberId
  )
    throw new Error("Wrong Airi WhatsApp sender");
  const client = getWhatsAppGraphClient();
  const normalizePage = (payload: {
    data?: unknown[];
    paging?: { next?: string };
  }) => {
    if (!Array.isArray(payload.data)) throw new Error("Invalid Graph page");
    return { data: payload.data, next: payload.paging?.next };
  };
  const phones = await collectMetaGraphEdge({
    client,
    accessToken: credentials.accessToken,
    path: `${IDENTITY.wabaId}/phone_numbers`,
    initialQuery: { fields: "id,verified_name", limit: 100 },
    maxPages: 3,
    maxItems: 300,
    createRequestSignal: () => AbortSignal.timeout(15000),
    normalizePage,
  });
  if (
    !phones.some(
      (phone: { id: string; verified_name: string }) =>
        phone.id === IDENTITY.phoneNumberId &&
        phone.verified_name === "airi.chat"
    )
  )
    throw new Error("Sender not verified on selected WABA");
  if (publishFlows) {
    await publishReviewedFlows(
      plan,
      { accessToken: credentials.accessToken, wabaId: IDENTITY.wabaId },
      receiptPath,
      apply
    );
    return;
  }
  const readTemplates = async (): Promise<ProviderTemplate[]> =>
    collectMetaGraphEdge({
      client,
      accessToken: credentials.accessToken,
      path: `${IDENTITY.wabaId}/message_templates`,
      initialQuery: {
        fields: "id,name,language,status,category,components",
        limit: 100,
      },
      maxPages: 6,
      maxItems: 600,
      createRequestSignal: () => AbortSignal.timeout(15000),
      normalizePage,
    });
  let receipt: Receipt = { entries: {} };
  try {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const persist = () =>
    writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  const accountContext = {
    workspaceId: IDENTITY.workspaceId,
    sourceId: IDENTITY.sourceId,
    wabaId: IDENTITY.wabaId,
    accessToken: credentials.accessToken,
    candidateSource: "credentials.waba_id",
  };
  const verifyLocalMirror = async (
    template: ProviderTemplate,
    rowId: string,
    variant: Variant
  ) => {
    const { data: proof, error: proofError } = await supabaseAdmin
      .from("message_templates")
      .select("id,whatsapp_data")
      .eq("id", rowId)
      .eq("workspace_id", IDENTITY.workspaceId)
      .maybeSingle();
    if (
      proofError ||
      !proof ||
      proof.whatsapp_data?.metaTemplateId !== template.id ||
      proof.whatsapp_data?.wabaId !== IDENTITY.wabaId ||
      proof.whatsapp_data?.status !== template.status
    )
      throw new Error(`Local mirror proof mismatch: ${variant.key}`);
    assertProviderIdentity(
      {
        ...template,
        language: proof.whatsapp_data.language,
        category: proof.whatsapp_data.category,
        components: proof.whatsapp_data.components,
      },
      variant
    );
  };
  for (const variant of plan.variants) {
    const expectedName = `airi_demo_${variant.catalogId.replaceAll("-", "_")}_${variant.language}_v1`;
    if (
      variant.payload.name !== expectedName ||
      variant.payload.category !== "MARKETING" ||
      variant.payload.language !== variant.language ||
      { en: "en", ru: "ru", kz: "kk" }[variant.locale] !== variant.language ||
      /__(?:MEDIA|PUBLIC|PUBLISHED|REAL)_/.test(JSON.stringify(variant.payload))
    )
      throw new Error(`Unresolved/unexpected variant: ${variant.key}`);
    const parsed = parseWhatsAppTemplateSubmissionComponents(
      variant.payload.components
    );
    if (!parsed.success)
      throw new Error(`Invalid template components: ${variant.key}`);
  }
  const initialTemplates = await readTemplates();
  if (auditReportPath) {
    const report = auditProviderTemplateSnapshot(
      initialTemplates,
      plan.variants
    );
    await writeFile(
      auditReportPath,
      JSON.stringify(
        { checkedAt: new Date().toISOString(), mode: "read_only", ...report },
        null,
        2
      ) + "\n",
      { flag: "wx" }
    );
    console.log(
      JSON.stringify({
        mode: "read_only",
        total: report.total,
        matched: report.matched,
        missing: report.missing.length,
        mismatched: report.mismatched.length,
        duplicateContent: report.duplicateContent.length,
      })
    );
    if (
      report.missing.length ||
      report.mismatched.length ||
      report.duplicateContent.length
    )
      process.exitCode = 1;
    return;
  }
  let existing = indexProviderTemplates(initialTemplates);
  // Check the entire plan before the first edit/create, including other provider names.
  for (const variant of plan.variants)
    assertNoDuplicateProviderContent(initialTemplates, variant);
  let createdCount = 0;
  let editedCount = 0;
  const variants = [...plan.variants].sort(
    (a, b) =>
      ({ ru: 0, en: 1, kk: 2 })[a.language] -
      { ru: 0, en: 1, kk: 2 }[b.language]
  );
  for (const variant of variants) {
    const providerTemplate = existing.get(
      providerTemplateKey(variant.payload.name, variant.language)
    );
    const { data: row, error: rowError } = await supabaseAdmin
      .from("message_templates")
      .select("id,whatsapp_data")
      .eq("workspace_id", IDENTITY.workspaceId)
      .eq("name", variant.payload.name)
      .maybeSingle();
    if (rowError) throw new Error(`Local lookup failed: ${variant.key}`);
    if (providerTemplate) {
      const action = getTemplateReconciliationAction(
        providerTemplate,
        variant,
        editExisting
      );
      if (
        !row ||
        row.whatsapp_data?.metaTemplateId !== providerTemplate.id ||
        row.whatsapp_data?.wabaId !== IDENTITY.wabaId ||
        row.whatsapp_data?.language !== variant.language
      )
        throw new Error(
          `Accepted provider template needs local reconciliation; do not recreate: ${variant.key} / ${providerTemplate.id}`
        );
      if (action === "edit") {
        if (hasTemplateUpdateFence(receipt.entries[variant.key]))
          throw new Error(
            `Uncertain prior edit requires reconciliation: ${variant.key}`
          );
        if (
          !apply ||
          !hasDemoMutationBudget(createdCount, editedCount, maxCreates)
        ) {
          console.log(
            JSON.stringify({
              key: variant.key,
              id: providerTemplate.id,
              action: "validated_edit",
            })
          );
          continue;
        }
        receipt.entries[variant.key] = {
          ...receipt.entries[variant.key],
          name: providerTemplate.name,
          language: variant.language,
          state: "updating",
          templateId: providerTemplate.id,
          recordId: row.id,
          updateStartedAt: new Date().toISOString(),
        };
        await persist();
        try {
          const updated = await updateWhatsAppTemplateMutation({
            workspaceId: IDENTITY.workspaceId,
            audit: { enabled: false },
            templateId: providerTemplate.id,
            category: "MARKETING",
            components: variant.payload.components,
            accountContext,
          });
          const verified = requireTemplateUpdateSnapshot(updated);
          assertProviderIdentity(verified, variant);
          await verifyLocalMirror(verified, row.id, variant);
          receipt.entries[variant.key] = verifiedReceiptEntry(
            receipt.entries[variant.key],
            verified,
            row.id
          );
          await persist();
          editedCount++;
          console.log(
            JSON.stringify({
              key: variant.key,
              id: verified.id,
              status: verified.status,
              action: "edited",
            })
          );
        } catch (error) {
          receipt.entries[variant.key] = reconciliationEntry(
            receipt.entries[variant.key],
            error,
            [...operatorSecrets]
          );
          await persist();
          throw new Error(operatorErrorMessage(error, [...operatorSecrets]));
        }
        continue;
      }
      if (
        apply &&
        requiresRecoveredTemplateMirror(receipt.entries[variant.key])
      ) {
        try {
          assertTemplateMirrorResult(
            await mirrorWhatsAppTemplate({
              supabase: supabaseAdmin,
              workspaceId: IDENTITY.workspaceId,
              template: providerTemplate,
            })
          );
          await verifyLocalMirror(providerTemplate, row.id, variant);
        } catch (error) {
          receipt.entries[variant.key] = reconciliationEntry(
            receipt.entries[variant.key],
            error,
            [...operatorSecrets]
          );
          await persist();
          throw new Error(operatorErrorMessage(error, [...operatorSecrets]));
        }
      }
      receipt.entries[variant.key] = verifiedReceiptEntry(
        receipt.entries[variant.key],
        providerTemplate,
        row.id
      );
      console.log(
        JSON.stringify({
          key: variant.key,
          id: providerTemplate.id,
          status: providerTemplate.status,
          action: "reused",
        })
      );
      continue;
    }
    if (variant.expectedTemplateId)
      throw new Error(
        `Reviewed existing template is missing; do not recreate: ${variant.key}`
      );
    if (row || hasTemplateCreationFence(receipt.entries[variant.key]))
      throw new Error(
        `Uncertain existing operation needs reconciliation: ${variant.key}`
      );
    if (
      !apply ||
      !hasDemoMutationBudget(createdCount, editedCount, maxCreates)
    ) {
      console.log(
        JSON.stringify({
          key: variant.key,
          action: "validated",
          status: "not_submitted",
        })
      );
      continue;
    }
    receipt.entries[variant.key] = {
      name: variant.payload.name,
      language: variant.language,
      state: "submitting",
      startedAt: new Date().toISOString(),
    };
    await persist();
    try {
      const created = await createUnifiedTemplateRecord({
        supabase: supabaseAdmin,
        workspaceId: IDENTITY.workspaceId,
        userId: IDENTITY.userId,
        name: variant.payload.name,
        channel: "whatsapp",
        whatsappData: {
          language: variant.language,
          category: variant.payload.category,
          components: variant.payload.components,
          wabaId: IDENTITY.wabaId,
        },
        accountContext,
        ...(deferCreatedStatusReadback
          ? { deferCreatedStatusReadback: true }
          : {}),
      });
      receipt.entries[variant.key] = {
        ...receipt.entries[variant.key],
        state: "accepted",
        templateId: created.metaTemplateId,
        recordId: created.id,
        status: created.metaTemplateStatus,
      };
      await persist();
      createdCount++;
      console.log(
        JSON.stringify({
          key: variant.key,
          id: created.metaTemplateId,
          status: created.metaTemplateStatus,
          action: "submitted",
        })
      );
    } catch (error) {
      receipt.entries[variant.key] = reconciliationEntry(
        receipt.entries[variant.key],
        error,
        [...operatorSecrets]
      );
      await persist();
      throw new Error(operatorErrorMessage(error, [...operatorSecrets]));
    }
  }
  existing = indexProviderTemplates(await readTemplates());
  const verifiedBatch = await verifyTemplateBatchSnapshots({
    variants,
    templates: existing,
    entries: receipt.entries,
    apply,
    editExisting,
    requireComplete: refreshReceipt || deferCreatedStatusReadback,
    mirrorAndVerify: async (template, rowId, variant) => {
      assertTemplateMirrorResult(
        await mirrorWhatsAppTemplate({
          supabase: supabaseAdmin,
          workspaceId: IDENTITY.workspaceId,
          template,
        })
      );
      await verifyLocalMirror(template, rowId, variant);
    },
  });
  receipt.entries = verifiedBatch.entries;
  const bindings = verifiedBatch.bindings;
  if (apply || refreshReceipt) {
    await persist();
    await writeFile(bindingsPath, JSON.stringify(bindings, null, 2) + "\n");
  }
  console.log(
    JSON.stringify({
      mode: apply ? "apply" : refreshReceipt ? "refresh_receipt" : "dry_run",
      matched: bindings.length,
      newlySubmitted: createdCount,
      edited: editedCount,
      approved: bindings.filter(
        binding =>
          existing.get(
            providerTemplateKey(
              String(binding.templateName),
              String(binding.language)
            )
          )?.status === "APPROVED"
      ).length,
    })
  );
}

if (require.main === module) {
  main()
    .catch(error => {
      console.error(operatorErrorMessage(error, [...operatorSecrets]));
      process.exitCode = 1;
    })
    .finally(async () => {
      // The canonical audit owner opens Mongo; release this operator's connection.
      const webRequire = createRequire(resolve("package.json"));
      await webRequire("mongoose").disconnect();
    });
}
