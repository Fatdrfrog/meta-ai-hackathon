import "server-only";

import { createHash, createHmac } from "node:crypto";
import connectDB from "@/lib/mongoose";
import { isMongoDuplicateKeyError } from "@/lib/mongo-errors";
import { fetchSourceWithCredentialsResult } from "@/lib/sources/utils";
import { sendWhatsappTemplate } from "@/lib/whatsapp";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { upsertWhatsAppMarketingConsent } from "@/lib/whatsapp/marketing-consent";
import {
  collectTemplateFlowIds,
  evaluateTemplateFlowHealth,
  hasTemplateFlowButton,
  isOpenableTemplateFlowStatus,
  TEMPLATE_FLOW_CHECK_MAX_FLOWS,
  type TemplateFlowFacts,
  type TemplateFlowFactsByFlowId,
} from "@/lib/whatsapp/flows/template-flow-health";
import { readTemplateFlowFacts } from "@/lib/whatsapp/flows/template-flow-facts";
import {
  buildWhatsAppTemplateSendComponentsFromTemplate,
  normalizeWhatsAppTemplateSendComponents,
  type WhatsAppTemplateSendComponentInput,
} from "@/lib/whatsapp/templates/message-types";
import PublicTemplateRequest, {
  type PublicTemplateRequestRecord,
} from "@/models/public-template-request";
import {
  collectMetaGraphEdge,
  getWhatsAppGraphClient,
  MetaGraphRequestError,
} from "@icecore/shared/lib/meta/api";
import {
  checkCriticalRateLimit,
  createRateLimiter,
} from "@icecore/shared/lib/rate-limiter";
import { cache, buildCacheKey } from "@icecore/shared/lib/cache";
import type {
  WhatsAppComponent,
  WhatsAppTemplate,
} from "@icecore/shared/types/whatsapp";
import { z } from "zod";
import { PUBLIC_TEMPLATES, getPublicTemplate } from "./public-template-catalog";
import { selectPublicTemplateManifest } from "./template-delivery-manifests.server";
import {
  publicTemplateLocaleSchema,
  publicTemplateReadinessSchema,
  type PublicTemplateLocale,
  type PublicTemplateReadiness,
  type PublicTemplateRequestBody,
} from "./template-request";

type DeliveryCode =
  | "unavailable"
  | "rate_limited"
  | "invalid_request"
  | "send_failed"
  | "unknown";
const ERROR_STATUSES: Record<DeliveryCode, number> = {
  unavailable: 503,
  rate_limited: 429,
  invalid_request: 400,
  send_failed: 502,
  unknown: 503,
};

export class PublicTemplateDeliveryError extends Error {
  readonly status: number;
  constructor(
    readonly code: DeliveryCode,
    readonly retryAfter?: number
  ) {
    super(code);
    this.name = "PublicTemplateDeliveryError";
    this.status = ERROR_STATUSES[code];
  }
}

class PublicTemplateFlowUnavailableError extends PublicTemplateDeliveryError {
  constructor() {
    super("unavailable");
  }
}

export type PublicTemplateDeliveryResult = {
  status: "accepted" | "processing";
};
const WRITE_OPTIONS = {
  runValidators: true,
  writeConcern: { w: "majority" as const, wtimeout: 5000 },
};
const graphClient = getWhatsAppGraphClient();
const MAX_PUBLIC_TEMPLATE_BINDINGS =
  PUBLIC_TEMPLATES.length * publicTemplateLocaleSchema.options.length;
const TEMPLATE_SNAPSHOT_MAX_ITEMS = Math.max(
  600,
  MAX_PUBLIC_TEMPLATE_BINDINGS * 2
);
const bindingSchema = z
  .object({
    catalogId: z.string().refine(value => Boolean(getPublicTemplate(value))),
    locale: publicTemplateLocaleSchema,
    templateId: z.string().regex(/^\d{1,32}$/),
    templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
    language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
    values: z.record(z.string().max(80), z.string().max(1024)).optional(),
    // Fixed send parameters are privileged configuration, never visitor input.
    components: z
      .array(
        z
          .object({ type: z.enum(["body", "header", "button", "carousel"]) })
          .passthrough()
      )
      .max(20)
      .optional(),
  })
  .strict()
  .refine(
    binding => Boolean(getPublicTemplate(binding.catalogId, binding.locale)),
    {
      path: ["locale"],
      message: "Template is not available in this locale",
    }
  );
type TemplateBinding = z.infer<typeof bindingSchema>;
type DeliveryConfig = {
  workspaceId: string;
  sourceId: string;
  rateSecret: string;
  bindings: TemplateBinding[];
};

function getConfig(): DeliveryConfig | null {
  const workspaceId = process.env.PUBLIC_WHATSAPP_TEMPLATE_WORKSPACE_ID?.trim();
  const sourceId = process.env.PUBLIC_WHATSAPP_TEMPLATE_SOURCE_ID?.trim();
  const rateSecret = process.env.PUBLIC_WHATSAPP_TEMPLATE_RATE_LIMIT_SECRET;
  if (
    !workspaceId ||
    !sourceId ||
    !rateSecret ||
    rateSecret.length < 32 ||
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  )
    return null;
  try {
    const selector = process.env.PUBLIC_WHATSAPP_TEMPLATE_MANIFEST;
    const inline = process.env.PUBLIC_WHATSAPP_TEMPLATE_BINDINGS;
    // A deployment must pick one explicit source of privileged send parameters.
    if (selector !== undefined && inline !== undefined) return null;
    const input =
      selector !== undefined
        ? selectPublicTemplateManifest(selector.trim())
        : JSON.parse(inline || "[]");
    const bindings = z
      .array(bindingSchema)
      .max(MAX_PUBLIC_TEMPLATE_BINDINGS)
      .parse(input);
    const keys = bindings.map(
      binding => `${binding.catalogId}:${binding.locale}`
    );
    if (new Set(keys).size !== keys.length) return null;
    return { workspaceId, sourceId, rateSecret, bindings };
  } catch {
    return null;
  }
}

async function getSender(config: DeliveryConfig) {
  const result = await fetchSourceWithCredentialsResult(
    config.sourceId,
    "whatsapp",
    { workspace_id: config.workspaceId }
  );
  if (
    !result.ok ||
    !result.source ||
    result.source.id !== config.sourceId ||
    result.source.workspace_id !== config.workspaceId ||
    result.source.type !== "whatsapp"
  ) {
    throw new PublicTemplateDeliveryError("unavailable");
  }
  const credentials = normalizeWhatsAppCredentials(result.source.credentials);
  if (
    !credentials.accessToken ||
    !credentials.phoneNumberId ||
    !credentials.wabaId
  ) {
    throw new PublicTemplateDeliveryError("unavailable");
  }
  return {
    accessToken: credentials.accessToken,
    phoneNumberId: credentials.phoneNumberId,
    wabaId: credentials.wabaId,
    messagingAccountId: credentials.messagingAccountId,
  };
}
type Sender = Awaited<ReturnType<typeof getSender>>;

function normalizeGraphPage<T>(payload: unknown): { data: T[]; next?: string } {
  const parsed = z
    .object({
      data: z.array(z.unknown()),
      paging: z.object({ next: z.string().optional() }).optional(),
    })
    .parse(payload);
  return { data: parsed.data as T[], next: parsed.paging?.next };
}

async function readSenderPhones(sender: Sender) {
  const phones = await collectMetaGraphEdge<{ id: string }>({
    client: graphClient,
    accessToken: sender.accessToken,
    path: `${sender.wabaId}/phone_numbers`,
    initialQuery: { fields: "id", limit: 100 },
    maxPages: 3,
    maxItems: 300,
    createRequestSignal: () => AbortSignal.timeout(8000),
    normalizePage: normalizeGraphPage,
  });
  if (!phones.some(phone => phone.id === sender.phoneNumberId))
    throw new PublicTemplateDeliveryError("unavailable");
}

async function readTemplates(sender: Sender, name?: string) {
  return collectMetaGraphEdge<WhatsAppTemplate>({
    client: graphClient,
    accessToken: sender.accessToken,
    path: `${sender.wabaId}/message_templates`,
    initialQuery: {
      ...(name ? { name } : {}),
      fields: "id,name,language,status,category,components",
      limit: 100,
    },
    maxPages: Math.ceil(TEMPLATE_SNAPSHOT_MAX_ITEMS / 100),
    maxItems: TEMPLATE_SNAPSHOT_MAX_ITEMS,
    createRequestSignal: () => AbortSignal.timeout(8000),
    normalizePage: normalizeGraphPage,
  });
}

function validateMediaHeaders(
  templateComponents: WhatsAppComponent[],
  sendComponents: WhatsAppTemplateSendComponentInput[] | undefined
) {
  for (const component of templateComponents) {
    if (component.type === "HEADER" && component.format === "LOCATION") {
      const header = sendComponents?.find(
        candidate => candidate.type === "header"
      );
      if (
        !header ||
        header.type !== "header" ||
        header.parameters.length !== 1 ||
        header.parameters[0]?.type !== "location"
      ) {
        throw new PublicTemplateDeliveryError("unavailable");
      }
    }
    if (
      component.type === "HEADER" &&
      ["IMAGE", "VIDEO", "DOCUMENT"].includes(component.format)
    ) {
      const format = component.format.toLowerCase();
      const header = sendComponents?.find(
        candidate => candidate.type === "header"
      );
      if (
        !header ||
        !("parameters" in header) ||
        !header.parameters.some(parameter => {
          if (parameter.type !== format || !(format in parameter)) return false;
          const media = (
            parameter as unknown as Record<
              string,
              { id?: string; link?: string }
            >
          )[format];
          if (media?.id?.trim()) return true;
          try {
            return ["https:", "http:"].includes(
              new URL(media?.link || "").protocol
            );
          } catch {
            return false;
          }
        })
      )
        throw new PublicTemplateDeliveryError("unavailable");
    }
    if (component.type === "CAROUSEL") {
      const carousel = sendComponents?.find(
        candidate => candidate.type === "carousel"
      );
      if (!carousel || carousel.type !== "carousel")
        throw new PublicTemplateDeliveryError("unavailable");
      for (let index = 0; index < component.cards.length; index += 1) {
        validateMediaHeaders(
          component.cards[index].components,
          carousel.cards.find(card => card.card_index === index)?.components
        );
      }
    }
  }
}

function validateRequiredComponents(
  required: WhatsAppTemplateSendComponentInput[] | undefined,
  actual: WhatsAppTemplateSendComponentInput[] | undefined
) {
  for (const component of required || []) {
    if (component.type === "carousel") {
      const target = actual?.find(candidate => candidate.type === "carousel");
      if (!target || target.type !== "carousel")
        throw new PublicTemplateDeliveryError("unavailable");
      for (const card of component.cards)
        validateRequiredComponents(
          card.components,
          target.cards.find(item => item.card_index === card.card_index)
            ?.components
        );
      continue;
    }
    const target = actual?.find(
      candidate =>
        candidate.type === component.type &&
        (component.type !== "button" ||
          (candidate.type === "button" &&
            candidate.sub_type === component.sub_type &&
            String(candidate.index) === String(component.index)))
    );
    if (
      !target ||
      target.type === "carousel" ||
      target.parameters.length !== component.parameters.length ||
      component.parameters.some((parameter, index) => {
        const candidate = target.parameters[index];
        return (
          candidate?.type !== parameter.type ||
          (parameter.type === "text" &&
            candidate?.type === "text" &&
            parameter.parameter_name !== candidate.parameter_name)
        );
      })
    )
      throw new PublicTemplateDeliveryError("unavailable");
  }
}

function validateFixedParameters(
  components: WhatsAppTemplateSendComponentInput[]
) {
  for (const component of components) {
    if (component.type === "carousel") {
      for (const card of component.cards)
        validateFixedParameters(card.components);
      continue;
    }
    for (const parameter of component.parameters) {
      if (
        (parameter.type === "text" && !parameter.text?.trim()) ||
        (parameter.type === "payload" && !parameter.payload?.trim()) ||
        (parameter.type === "action" && !parameter.action?.flow_token?.trim())
      )
        throw new PublicTemplateDeliveryError("unavailable");
    }
  }
}

function findBindingTemplate(
  binding: TemplateBinding,
  templates: WhatsAppTemplate[]
) {
  return templates.find(
    candidate =>
      candidate.id === binding.templateId &&
      candidate.name === binding.templateName &&
      candidate.language === binding.language &&
      candidate.status === "APPROVED" &&
      candidate.category === "MARKETING"
  );
}

async function resolveBinding(
  sender: Sender,
  binding: TemplateBinding,
  snapshot?: WhatsAppTemplate[],
  snapshotFlowFacts?: TemplateFlowFactsByFlowId
) {
  const templates =
    snapshot || (await readTemplates(sender, binding.templateName));
  const template = findBindingTemplate(binding, templates);
  if (!template?.components?.length)
    throw new PublicTemplateDeliveryError("unavailable");
  if (hasTemplateFlowButton(template.components)) {
    const flowIds = collectTemplateFlowIds(template.components);
    if (!flowIds.length) throw new PublicTemplateDeliveryError("unavailable");
    const facts = snapshotFlowFacts
      ? flowIds.flatMap(flowId =>
          snapshotFlowFacts[flowId] ? [snapshotFlowFacts[flowId]!] : []
        )
      : await readTemplateFlowFacts({
          wabaId: sender.wabaId,
          accessToken: sender.accessToken,
          flowIds,
          refresh: !snapshot,
        });
    const health = evaluateTemplateFlowHealth(
      template.components,
      Object.fromEntries(facts.map(fact => [fact.flowId, fact]))
    );
    if (
      health.state === "unverified" &&
      facts.some(
        fact =>
          fact.state === "unavailable" ||
          (fact.state === "found" &&
            isOpenableTemplateFlowStatus(fact.status) &&
            fact.screenIds === null)
      )
    )
      throw new PublicTemplateFlowUnavailableError();
    if (health.state !== "ok")
      throw new PublicTemplateDeliveryError("unavailable");
  }
  const fixedComponents = binding.components as
    | WhatsAppTemplateSendComponentInput[]
    | undefined;
  const header = fixedComponents?.find(
    component => component.type === "header"
  );
  const locationParameter =
    header?.type === "header"
      ? header.parameters.find(parameter => parameter.type === "location")
      : undefined;
  const inferred = buildWhatsAppTemplateSendComponentsFromTemplate({
    templateComponents: template.components,
    values: binding.values,
    headerLocation:
      locationParameter?.type === "location"
        ? locationParameter.location
        : undefined,
    resolveVariableValue: ({ variable }) => {
      const value = binding.values?.[variable]?.trim();
      if (!value && binding.components) return `required_${variable}`;
      if (!value) throw new PublicTemplateDeliveryError("unavailable");
      return value;
    },
  });
  if (!binding.components && inferred.issues.length)
    throw new PublicTemplateDeliveryError("unavailable");
  if (fixedComponents) validateFixedParameters(fixedComponents);
  const components = fixedComponents
    ? normalizeWhatsAppTemplateSendComponents(fixedComponents)
    : inferred.components;
  validateRequiredComponents(inferred.components, components);
  validateMediaHeaders(template.components, components);
  return { template, components };
}

const readinessSchema = z
  .object({
    en: publicTemplateReadinessSchema,
    ru: publicTemplateReadinessSchema,
    kz: publicTemplateReadinessSchema,
  })
  .strict();
type PublicTemplateReadinessByLocale = z.infer<typeof readinessSchema>;
const readinessCacheSchema = z
  .object({
    readiness: readinessSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
type CachedPublicTemplateReadiness = z.infer<typeof readinessCacheSchema>;
let readiness:
  | {
      digest: string;
      expiresAt: number;
      promise: Promise<CachedPublicTemplateReadiness>;
    }
  | undefined;

/** Readiness shares a five-minute cache; every POST verifies approval live again. */
export async function getPublicTemplateReadiness(
  locale: PublicTemplateLocale
): Promise<PublicTemplateReadiness> {
  const config = getConfig();
  const bindings =
    config?.bindings.filter(binding => binding.locale === locale) || [];
  if (!config || !bindings.length)
    return { readyTemplateIds: [], unavailableTemplateIds: [] };
  const digest = createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
  const cached = readiness;
  if (cached?.digest === digest && cached.expiresAt > Date.now())
    return (await cached.promise).readiness[locale];
  const promise = (async () => {
    try {
      const key = buildCacheKey("landing:public-template-readiness:v4", [
        digest,
      ]);
      const cachedIds = await cache.get<unknown>(key).catch(() => null);
      const parsedIds = readinessCacheSchema.safeParse(cachedIds);
      if (
        parsedIds.success &&
        parsedIds.data.expiresAt > Date.now() &&
        parsedIds.data.expiresAt <= Date.now() + 300_000 &&
        publicTemplateLocaleSchema.options.every(selectedLocale =>
          [
            ...parsedIds.data.readiness[selectedLocale].readyTemplateIds,
            ...parsedIds.data.readiness[selectedLocale].unavailableTemplateIds,
          ].every(id =>
            config.bindings.some(
              binding =>
                binding.locale === selectedLocale && binding.catalogId === id
            )
          )
        )
      )
        return parsedIds.data;
      const budget = await checkCriticalRateLimit(
        createRateLimiter({
          requests: 1,
          window: "5 m",
          prefix: "landing:template:readiness-refresh",
          analytics: false,
        }),
        // Binding changes and locale switches must not buy another provider budget.
        createHmac("sha256", config.rateSecret)
          .update(JSON.stringify([config.workspaceId, config.sourceId]))
          .digest("hex")
      );
      if (budget.status !== "granted")
        throw new PublicTemplateDeliveryError("unavailable");
      const sender = await getSender(config);
      await readSenderPhones(sender);
      const snapshot = await readTemplates(sender);
      const flowIds = Array.from(
        new Set(
          config.bindings.flatMap(binding => {
            const template = findBindingTemplate(binding, snapshot);
            return template?.components
              ? collectTemplateFlowIds(template.components)
              : [];
          })
        )
      );
      const flowFacts: TemplateFlowFacts[] = [];
      // The canonical reader owns its cache and four-read concurrency. Preserve
      // its per-call bound without silently dropping the 26th or later Flow.
      for (
        let offset = 0;
        offset < flowIds.length;
        offset += TEMPLATE_FLOW_CHECK_MAX_FLOWS
      ) {
        flowFacts.push(
          ...(await readTemplateFlowFacts({
            wabaId: sender.wabaId,
            accessToken: sender.accessToken,
            flowIds: flowIds.slice(
              offset,
              offset + TEMPLATE_FLOW_CHECK_MAX_FLOWS
            ),
            refresh: false,
          }))
        );
      }
      const factsById = Object.fromEntries(
        flowFacts.map(fact => [fact.flowId, fact])
      );
      const resultByLocale: PublicTemplateReadinessByLocale = {
        en: { readyTemplateIds: [], unavailableTemplateIds: [] },
        ru: { readyTemplateIds: [], unavailableTemplateIds: [] },
        kz: { readyTemplateIds: [], unavailableTemplateIds: [] },
      };
      // Resolve the finite catalog against one shared snapshot, two at a time.
      for (let offset = 0; offset < config.bindings.length; offset += 2) {
        const batch = await Promise.allSettled(
          config.bindings.slice(offset, offset + 2).map(async binding => {
            try {
              await resolveBinding(sender, binding, snapshot, factsById);
              return { binding, state: "ready" as const };
            } catch (error) {
              if (error instanceof PublicTemplateFlowUnavailableError)
                return { binding, state: "unavailable" as const };
              throw error;
            }
          })
        );
        for (const item of batch)
          if (item.status === "fulfilled") {
            const { binding, state } = item.value;
            const ids =
              state === "ready"
                ? resultByLocale[binding.locale].readyTemplateIds
                : resultByLocale[binding.locale].unavailableTemplateIds;
            ids.push(binding.catalogId);
          }
      }
      const result: CachedPublicTemplateReadiness = {
        readiness: resultByLocale,
        expiresAt: Date.now() + 300_000,
      };
      await cache.set(key, result, 300).catch(() => undefined);
      return result;
    } catch {
      const failed = readiness;
      if (failed?.digest === digest) failed.expiresAt = Date.now() + 1000;
      throw new PublicTemplateDeliveryError("unavailable");
    }
  })();
  readiness = { digest, expiresAt: Date.now() + 300_000, promise };
  const result = await promise;
  if (readiness?.promise === promise) readiness.expiresAt = result.expiresAt;
  return result.readiness[locale];
}

async function applyRateLimits(
  config: DeliveryConfig,
  phone: string,
  ip: string,
  phase: "ip" | "send"
) {
  const limits = [
    {
      requests: 5,
      window: "10 m" as const,
      prefix: "landing:template:ip",
      key: `ip:${ip}`,
    },
    {
      requests: 3,
      window: "1 h" as const,
      prefix: "landing:template:phone",
      key: `phone:${phone}`,
    },
    {
      requests: 10,
      window: "1 d" as const,
      prefix: "landing:template:phone-daily",
      key: `phone:${phone}`,
    },
    {
      requests: 100,
      window: "1 h" as const,
      prefix: "landing:template:global",
      key: "global",
    },
  ];
  for (const { key, ...limit } of limits.filter(item =>
    phase === "ip" ? item.key.startsWith("ip:") : !item.key.startsWith("ip:")
  )) {
    const identifier = createHmac("sha256", config.rateSecret)
      .update(key)
      .digest("hex");
    const result = await checkCriticalRateLimit(
      createRateLimiter({ ...limit, analytics: false }),
      identifier
    );
    if (result.status === "unavailable")
      throw new PublicTemplateDeliveryError("unavailable");
    if (result.status === "limited")
      throw new PublicTemplateDeliveryError(
        "rate_limited",
        Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))
      );
  }
}

async function assertPublicTemplateIpRequestAllowed(
  ip: string,
  kind: "readiness" | "submission"
): Promise<void> {
  const config = getConfig();
  if (!config?.bindings.length) return;
  const identifier = createHmac("sha256", config.rateSecret)
    .update(`${kind}-ip:${ip}`)
    .digest("hex");
  const result = await checkCriticalRateLimit(
    createRateLimiter({
      requests: 20,
      window: "1 m",
      prefix: `landing:template:${kind}-ip`,
      analytics: false,
    }),
    identifier
  );
  if (result.status === "unavailable")
    throw new PublicTemplateDeliveryError("unavailable");
  if (result.status === "limited")
    throw new PublicTemplateDeliveryError(
      "rate_limited",
      Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))
    );
}

export async function assertPublicTemplateReadinessRequestAllowed(
  ip: string
): Promise<void> {
  await assertPublicTemplateIpRequestAllowed(ip, "readiness");
}

/** Reject repeated submissions before parsing, including invalid input and bots. */
export async function assertPublicTemplateSubmissionRequestAllowed(
  ip: string
): Promise<void> {
  await assertPublicTemplateIpRequestAllowed(ip, "submission");
}

function readReplay(
  record: PublicTemplateRequestRecord,
  digest: string
): PublicTemplateDeliveryResult {
  if (record.payloadDigest !== digest)
    throw new PublicTemplateDeliveryError("invalid_request");
  if (record.state === "accepted") return { status: "accepted" };
  if (record.state === "failed")
    throw new PublicTemplateDeliveryError("send_failed");
  return { status: "processing" };
}

export async function requestPublicTemplate(
  body: PublicTemplateRequestBody,
  ip: string
): Promise<PublicTemplateDeliveryResult> {
  // Provider preflight can be slow. A withdrawal received during it must stay
  // newer than the checkbox event rather than being replaced by dispatch time.
  const consentedAt = new Date();
  const config = getConfig();
  const binding = config?.bindings.find(
    item => item.catalogId === body.templateId && item.locale === body.locale
  );
  if (!config || !binding) throw new PublicTemplateDeliveryError("unavailable");
  const operationId = createHash("sha256")
    .update(`public-template:${body.requestId}`)
    .digest("hex");
  const payloadDigest = createHash("sha256")
    .update(
      JSON.stringify([
        body.templateId,
        body.locale,
        body.name,
        body.email,
        body.phone,
        body.source,
        body.consentVersion,
      ])
    )
    .digest("hex");
  await applyRateLimits(config, body.phone, ip, "ip");
  try {
    await connectDB();
    const existing = await PublicTemplateRequest.findById(operationId).lean();
    if (existing) return readReplay(existing, payloadDigest);
  } catch (error) {
    if (error instanceof PublicTemplateDeliveryError) throw error;
    throw new PublicTemplateDeliveryError("unavailable");
  }
  await applyRateLimits(config, body.phone, ip, "send");
  let sender: Sender;
  let resolved: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    sender = await getSender(config);
    await readSenderPhones(sender);
    resolved = await resolveBinding(sender, binding);
  } catch {
    throw new PublicTemplateDeliveryError("unavailable");
  }
  try {
    await PublicTemplateRequest.create(
      [
        {
          _id: operationId,
          payloadDigest,
          workspaceId: config.workspaceId,
          sourceId: config.sourceId,
          templateId: body.templateId,
          metaTemplateId: binding.templateId,
          templateName: binding.templateName,
          language: binding.language,
          locale: body.locale,
          name: body.name,
          email: body.email,
          phone: body.phone,
          source: body.source,
          consentVersion: body.consentVersion,
          consentedAt,
          marketingConsent: true,
          state: "reserved",
        },
      ],
      { writeConcern: WRITE_OPTIONS.writeConcern }
    );
  } catch (error) {
    if (isMongoDuplicateKeyError(error)) {
      try {
        const record = await PublicTemplateRequest.findById(operationId).lean();
        if (record) return readReplay(record, payloadDigest);
      } catch (readError) {
        if (readError instanceof PublicTemplateDeliveryError) throw readError;
      }
    }
    throw new PublicTemplateDeliveryError("unknown");
  }
  const filter = {
    _id: operationId,
    payloadDigest,
    state: { $in: ["reserved", "dispatching"] },
  };
  let dispatchStarted = false;
  let accepted: { messageId: string; date: number } | undefined;
  try {
    await upsertWhatsAppMarketingConsent({
      workspaceId: config.workspaceId,
      sourceId: config.sourceId,
      waId: body.phone.slice(1),
      phoneNumberId: sender.phoneNumberId,
      wabaId: sender.wabaId,
      status: true,
      source: "public_template_checkbox",
      eventAt: consentedAt,
      eventKey: `public-template:${operationId}:marketing-consent:${body.consentVersion}`,
      category: "marketing_messages",
      preferenceValue: "opt_in",
      landingPage: body.source,
      payload: {
        requestId: operationId,
        consentVersion: body.consentVersion,
        templateId: body.templateId,
        locale: body.locale,
      },
    });
    accepted = await sendWhatsappTemplate(
      sender.phoneNumberId,
      sender.accessToken,
      { kind: "phone", value: body.phone.slice(1) },
      binding.templateName,
      binding.language,
      resolved.components,
      {
        requirePhoneRecipient: true,
        redactTemplatePayloadInLogs: true,
        messagingAccountId: sender.messagingAccountId,
        beforeSend: async () => {
          const result = await PublicTemplateRequest.updateOne(
            { _id: operationId, payloadDigest, state: "reserved" },
            { $set: { state: "dispatching", dispatchedAt: new Date() } },
            WRITE_OPTIONS
          );
          if (result.matchedCount !== 1)
            throw new PublicTemplateDeliveryError("unknown");
          dispatchStarted = true;
        },
      }
    );
    const result = await PublicTemplateRequest.updateOne(
      filter,
      {
        $set: {
          state: "accepted",
          providerMessageId: accepted.messageId,
          acceptedAt: new Date(accepted.date * 1000),
        },
      },
      WRITE_OPTIONS
    );
    if (result.matchedCount !== 1)
      throw new PublicTemplateDeliveryError("unknown");
    return { status: "accepted" };
  } catch (error) {
    const explicitRejection =
      dispatchStarted &&
      error instanceof MetaGraphRequestError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408;
    const state = !dispatchStarted || explicitRejection ? "failed" : "unknown";
    try {
      await PublicTemplateRequest.updateOne(
        filter,
        {
          $set: {
            state,
            ...(accepted
              ? {
                  providerMessageId: accepted.messageId,
                  acceptedAt: new Date(accepted.date * 1000),
                }
              : {}),
          },
        },
        WRITE_OPTIONS
      );
    } catch {
      /* The existing durable reservation still prevents another dispatch. */
    }
    if (state === "failed")
      throw new PublicTemplateDeliveryError("send_failed");
    return { status: "processing" };
  }
}
