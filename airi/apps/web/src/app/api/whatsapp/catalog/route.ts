import { isTemporalConfigured } from "@/lib/temporal/client";
import { startWhatsAppCatalogImportWorkflow } from "@/lib/temporal/whatsapp-catalog-import";
import {
  sendWhatsappCatalogLinkMessage,
  sendWhatsappCatalogMessage,
  sendWhatsappMultiProductMessage,
  sendWhatsappProductCarouselMessage,
  sendWhatsappSingleProductMessage,
} from "@/lib/whatsapp";
import {
  CATALOG_PERMISSION,
  createCatalogProduct,
  dedupeCatalogs,
  deleteCatalogProduct,
  getCatalogCommerceSettings,
  isCatalogPermissionError,
  isWabaCatalogUnsupportedMethodError,
  listBusinessOwnedProductCatalogs,
  listCatalogProducts,
  listWabaProductCatalogs,
  parseCatalogCsvRows,
  serializeCatalogProductsCsv,
  updateCatalogCommerceSettings,
  updateCatalogProduct,
  type CatalogProductInput,
  type CatalogProductUpdateInput,
} from "@/lib/whatsapp/catalog/service";
import { runWhatsAppCatalogSetup } from "@/lib/whatsapp/catalog/setup";
import { updateCurrentWhatsAppSourceCredentials } from "@/lib/whatsapp/flows/source-rebind-guard";
import { getWhatsAppWorkspaceContext } from "@/lib/whatsapp/get-workspace-context";
import { MetaGraphRequestError } from "@icecore/shared/lib/meta/api";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requiredFieldResponse } from "@/lib/api/json-body";

const CATALOG_IMPORT_BATCH_SIZE = 100;
const TEMPORAL_INLINE_WORKFLOW_PAYLOAD_BYTE_LIMIT = 900_000;

const AvailabilitySchema = z.enum([
  "in stock",
  "out of stock",
  "preorder",
  "available for order",
  "discontinued",
  "pending",
  "mark_as_sold",
  "mark_as_expired",
]);

const ConditionSchema = z.enum([
  "new",
  "refurbished",
  "used",
  "used_like_new",
  "used_good",
  "used_fair",
  "cpo",
  "open_box_new",
]);

const OptionalProductFieldsSchema = z.object({
  additional_image_urls: z.array(z.string().url()).optional(),
  sale_price: z.union([z.string().min(1), z.number().nonnegative()]).optional(),
  inventory: z.union([z.number().int().nonnegative(), z.string()]).optional(),
  product_type: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  google_product_category: z.string().max(200).optional(),
  color: z.string().max(100).optional(),
  size: z.string().max(100).optional(),
  material: z.string().max(100).optional(),
  gender: z.string().max(40).optional(),
  age_group: z.string().max(40).optional(),
  custom_label_0: z.string().max(100).optional(),
  custom_label_1: z.string().max(100).optional(),
  custom_label_2: z.string().max(100).optional(),
  custom_label_3: z.string().max(100).optional(),
  custom_label_4: z.string().max(100).optional(),
});

const ProductMutationBaseSchema = z.object({
  workspaceId: z.string().min(1),
  catalogId: z.string().min(1).optional(),
  catalogueId: z.string().min(1).optional(),
});

const ProductPayloadSchema = z
  .object({
    retailer_id: z.string().min(1).max(100),
    name: z.string().min(1).max(150),
    description: z.string().min(1).max(5000),
    price: z.union([z.string().min(1), z.number().nonnegative()]),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    image_url: z.string().url(),
    url: z.string().url(),
    brand: z.string().min(1).max(100).optional(),
    availability: AvailabilitySchema.default("in stock"),
    condition: ConditionSchema.default("new"),
  })
  .merge(OptionalProductFieldsSchema);

const CreateProductSchema = ProductMutationBaseSchema.merge(
  ProductPayloadSchema
)
  .extend({
    action: z.literal("create_product").optional(),
  })
  .refine(value => value.catalogId || value.catalogueId, {
    message: "catalogId is required",
    path: ["catalogId"],
  });

const UpdateProductSchema = ProductMutationBaseSchema.extend({
  retailer_id: z.string().min(1).max(100),
  name: z.string().min(1).max(150).optional(),
  description: z.string().min(1).max(5000).optional(),
  price: z.union([z.string().min(1), z.number().nonnegative()]).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  image_url: z.string().url().optional(),
  url: z.string().url().optional(),
  brand: z.string().min(1).max(100).optional(),
  availability: AvailabilitySchema.optional(),
  condition: ConditionSchema.optional(),
})
  .merge(OptionalProductFieldsSchema)
  .refine(value => value.catalogId || value.catalogueId, {
    message: "catalogId is required",
    path: ["catalogId"],
  })
  .refine(
    value =>
      [
        value.name,
        value.description,
        value.price,
        value.currency,
        value.image_url,
        value.url,
        value.brand,
        value.availability,
        value.condition,
        value.additional_image_urls,
        value.sale_price,
        value.inventory,
        value.product_type,
        value.category,
        value.google_product_category,
        value.color,
        value.size,
        value.material,
        value.gender,
        value.age_group,
        value.custom_label_0,
        value.custom_label_1,
        value.custom_label_2,
        value.custom_label_3,
        value.custom_label_4,
      ].some(item => item !== undefined),
    {
      message: "Provide at least one product field to update",
      path: ["product"],
    }
  );

const BulkImportSchema = z.object({
  action: z.literal("bulk_import"),
  workspaceId: z.string().min(1),
  catalogId: z.string().min(1),
  dryRun: z.boolean().default(true),
  csv: z.string().optional(),
  items: z.array(ProductPayloadSchema).optional(),
});

const CatalogSetupSchema = z.object({
  action: z.literal("setup"),
  workspaceId: z.string().min(1),
});

const CommerceSettingsSchema = z.object({
  action: z.literal("commerce_settings"),
  workspaceId: z.string().min(1),
  is_cart_enabled: z.boolean().optional(),
  is_catalog_visible: z.boolean().optional(),
  catalog_id: z.string().optional(),
});

const SendCatalogMessageSchema = z.object({
  action: z.literal("send_catalog_message"),
  workspaceId: z.string().min(1),
  to: z.string().min(1),
  bodyText: z.string().min(1).max(1024),
  footerText: z.string().max(60).optional(),
  thumbnailProductRetailerId: z.string().optional(),
});

const SendCatalogLinkMessageSchema = z.object({
  action: z.literal("send_catalog_link_message"),
  workspaceId: z.string().min(1),
  to: z.string().min(1),
  businessPhoneNumber: z.string().min(1),
  bodyText: z.string().min(1).max(1024),
});

const SendSingleProductMessageSchema = z.object({
  action: z.literal("send_single_product_message"),
  workspaceId: z.string().min(1),
  to: z.string().min(1),
  catalogId: z.string().min(1),
  productRetailerId: z.string().min(1),
  bodyText: z.string().max(1024).optional(),
  footerText: z.string().max(60).optional(),
});

const SendMultiProductMessageSchema = z.object({
  action: z.literal("send_multi_product_message"),
  workspaceId: z.string().min(1),
  to: z.string().min(1),
  catalogId: z.string().min(1),
  headerText: z.string().min(1).max(60),
  bodyText: z.string().min(1).max(1024),
  footerText: z.string().max(60).optional(),
  sections: z
    .array(
      z.object({
        title: z.string().min(1).max(24),
        productRetailerIds: z.array(z.string().min(1)).min(1).max(30),
      })
    )
    .min(1),
});

const SendCarouselMessageSchema = z.object({
  action: z.literal("send_product_carousel_message"),
  workspaceId: z.string().min(1),
  to: z.string().min(1),
  catalogId: z.string().min(1),
  bodyText: z.string().min(1).max(1024),
  productRetailerIds: z.array(z.string().min(1)).min(2).max(10),
});

type Readiness = {
  hasWabaId: boolean;
  hasBusinessId: boolean;
  hasAccessToken: boolean;
  hasPhoneNumberId: boolean;
  fullCloudCatalogCapable: boolean;
};

function resolveCatalogId(input: { catalogId?: string; catalogueId?: string }) {
  return (input.catalogId || input.catalogueId || "").trim();
}

function isCoexistenceConnection(context: {
  credentials: {
    embeddedSignupFlow?: string;
    coexistenceMode?: boolean;
    isOnBizApp?: boolean;
    platformType?: string;
  };
}) {
  if (
    context.credentials.embeddedSignupFlow === "cloud_api" &&
    context.credentials.isOnBizApp !== true &&
    !String(context.credentials.platformType || "")
      .toUpperCase()
      .includes("COEXISTENCE") &&
    !String(context.credentials.platformType || "")
      .toUpperCase()
      .includes("SMB")
  ) {
    return false;
  }

  return (
    context.credentials.embeddedSignupFlow === "coexistence" ||
    context.credentials.coexistenceMode === true ||
    context.credentials.isOnBizApp === true
  );
}

function buildReadiness(context: {
  accessToken?: string;
  credentials: {
    businessId?: string;
    embeddedSignupFlow?: string;
    coexistenceMode?: boolean;
    isOnBizApp?: boolean;
    platformType?: string;
  };
  phoneNumberId?: string;
  wabaId?: string;
}): Readiness {
  const hasAccessToken = Boolean(context.accessToken);
  const hasWabaId = Boolean(context.wabaId);
  const hasBusinessId = Boolean(context.credentials.businessId);
  return {
    hasWabaId,
    hasBusinessId,
    hasAccessToken,
    hasPhoneNumberId: Boolean(context.phoneNumberId),
    fullCloudCatalogCapable:
      hasAccessToken &&
      (hasWabaId || hasBusinessId) &&
      !isCoexistenceConnection(context),
  };
}

function buildMissingPermissionResponse(readiness: Readiness) {
  return NextResponse.json({
    catalogs: [],
    catalogues: [],
    products: [],
    selectedCatalog: null,
    selectedCatalogue: null,
    readiness,
    setupStatus: "reconnect_required",
    checks: [],
    blockingIssues: [
      {
        code: "catalog_permission_missing",
        message: "Catalog access is missing.",
        actionable:
          "Reconnect WhatsApp after granting catalog_management and assigning the Catalogs asset.",
      },
    ],
    diagnostics: [],
    missingPermissions: [CATALOG_PERMISSION],
    requiresReconnect: true,
    error:
      "Catalog access is missing. Reconnect WhatsApp through full Cloud API Embedded Signup after adding catalog_management and the Catalogs asset in Meta Developer Portal.",
  });
}

async function saveCatalogSetupCredentialsPatch(
  sourceId: string,
  workspaceId: string,
  expectedWabaId: string,
  nextCredentials: Record<string, unknown>
) {
  const patch: Record<string, unknown> = {};

  if (Array.isArray(nextCredentials.catalog_ids)) {
    patch.catalog_ids = nextCredentials.catalog_ids;
  }
  if (
    nextCredentials.catalog_setup &&
    typeof nextCredentials.catalog_setup === "object"
  ) {
    patch.catalog_setup = nextCredentials.catalog_setup;
  }

  await updateCurrentWhatsAppSourceCredentials({
    workspaceId,
    sourceId,
    expectedWabaId,
    buildCredentials: current => ({ ...current, ...patch }),
  });
}

function buildMetaErrorResponse(error: unknown, fallback: string) {
  if (isCatalogPermissionError(error)) {
    return NextResponse.json(
      {
        error:
          "Catalog access is missing. Reconnect WhatsApp to grant catalog_management.",
        missingPermissions: [CATALOG_PERMISSION],
        requiresReconnect: true,
      },
      { status: 403 }
    );
  }

  if (error instanceof MetaGraphRequestError) {
    return NextResponse.json(
      {
        error: error.formattedError?.message || error.message || fallback,
        actionable: error.formattedError?.actionable || null,
        requiresReconnect: error.formattedError?.requiresReconnect || false,
        details: error.metaError
          ? {
              code: error.metaError.code,
              subcode: error.metaError.error_subcode,
              fbtrace_id: error.metaError.fbtrace_id,
            }
          : undefined,
      },
      { status: error.status || 500 }
    );
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 }
  );
}

function buildUpdateInput(
  body: z.infer<typeof UpdateProductSchema>
): CatalogProductUpdateInput {
  const product: CatalogProductUpdateInput = {};
  for (const key of [
    "name",
    "description",
    "price",
    "currency",
    "image_url",
    "url",
    "brand",
    "availability",
    "condition",
    "additional_image_urls",
    "sale_price",
    "inventory",
    "product_type",
    "category",
    "google_product_category",
    "color",
    "size",
    "material",
    "gender",
    "age_group",
    "custom_label_0",
    "custom_label_1",
    "custom_label_2",
    "custom_label_3",
    "custom_label_4",
  ] as const) {
    if (body[key] !== undefined) {
      (product as Record<string, unknown>)[key] = body[key];
    }
  }
  return product;
}

async function getManagerContext(
  workspaceId: string,
  message: string,
  options: { requirePhoneNumber?: boolean } = {}
) {
  return getWhatsAppWorkspaceContext(workspaceId, {
    managerErrorMessage: message,
    requireManager: true,
    requirePhoneNumber: options.requirePhoneNumber === true,
  });
}

async function getCatalogManagerContext(
  workspaceId: string,
  message: string,
  options: { requirePhoneNumber?: boolean } = {}
) {
  const accessResult = await getManagerContext(workspaceId, message, options);
  if (accessResult.error) return accessResult;

  const readiness = buildReadiness(accessResult.context);
  if (!readiness.fullCloudCatalogCapable) {
    return {
      error: NextResponse.json(
        {
          error: isCoexistenceConnection(accessResult.context)
            ? "WhatsApp Catalog requires a full Cloud API connection. Coexistence connections must reconnect through the full Cloud API Embedded Signup configuration."
            : "WhatsApp Catalog requires full Cloud API catalog access.",
          readiness,
          requiresReconnect: isCoexistenceConnection(accessResult.context),
        },
        { status: 403 }
      ),
    };
  }

  return accessResult;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId")?.trim();
    const requestedCatalogId = (
      searchParams.get("catalogId") ||
      searchParams.get("catalogueId") ||
      ""
    ).trim();
    const exportCsv = searchParams.get("export") === "csv";
    const includeCommerceSettings =
      searchParams.get("includeCommerceSettings") === "1";
    const limitParam = Number(searchParams.get("limit") || 200);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(Math.floor(limitParam), 1), 500)
      : 200;

    if (!workspaceId) return requiredFieldResponse("workspaceId");

    const accessResult = await getWhatsAppWorkspaceContext(workspaceId, {
      requireCredentials: false,
    });
    if (accessResult.error) return accessResult.error;

    const { context } = accessResult;
    const readiness = buildReadiness(context);

    if (!readiness.fullCloudCatalogCapable) {
      return NextResponse.json({
        catalogs: [],
        catalogues: [],
        products: [],
        selectedCatalog: null,
        selectedCatalogue: null,
        readiness,
        setupStatus: isCoexistenceConnection(context)
          ? "reconnect_required"
          : "manual_action",
        checks: [],
        blockingIssues: [
          {
            code: isCoexistenceConnection(context)
              ? "full_cloud_required"
              : "catalog_access_incomplete",
            message: isCoexistenceConnection(context)
              ? "WhatsApp Catalog requires a full Cloud API connection."
              : "WhatsApp Catalog requires full Cloud API catalog access.",
            actionable: isCoexistenceConnection(context)
              ? "Reconnect WhatsApp with the full Cloud API Embedded Signup."
              : "Reconnect WhatsApp and grant catalog access.",
          },
        ],
        diagnostics: [],
        missingPermissions: [],
        requiresReconnect: isCoexistenceConnection(context),
        error: isCoexistenceConnection(context)
          ? "WhatsApp Catalog requires a full Cloud API connection. Coexistence connections must reconnect through the full Cloud API Embedded Signup configuration."
          : null,
      });
    }

    const accessToken = context.accessToken || "";
    const catalogResults = await Promise.allSettled([
      context.wabaId
        ? listWabaProductCatalogs({
            accessToken,
            wabaId: context.wabaId,
          })
        : Promise.resolve([]),
      context.credentials.businessId
        ? listBusinessOwnedProductCatalogs({
            accessToken,
            businessId: context.credentials.businessId,
          })
        : Promise.resolve([]),
    ]);

    const catalogs = dedupeCatalogs(
      catalogResults.flatMap(result =>
        result.status === "fulfilled" ? result.value : []
      )
    );
    const diagnostics = catalogResults.flatMap(result => {
      if (
        result.status === "rejected" &&
        isWabaCatalogUnsupportedMethodError(result.reason)
      ) {
        return [
          {
            code: "waba_product_catalogs_unknown_method",
            message:
              "Meta rejected the WABA product_catalogs read edge; continuing with business catalog checks.",
          },
        ];
      }
      return [];
    });

    const permissionFailure = catalogResults.find(
      result =>
        result.status === "rejected" && isCatalogPermissionError(result.reason)
    );
    if (permissionFailure && catalogs.length === 0) {
      return buildMissingPermissionResponse(readiness);
    }

    const rejected = catalogResults.find(
      result =>
        result.status === "rejected" &&
        !isCatalogPermissionError(result.reason) &&
        !isWabaCatalogUnsupportedMethodError(result.reason)
    );
    if (rejected?.status === "rejected" && catalogs.length === 0) {
      return buildMetaErrorResponse(
        rejected.reason,
        "Failed to fetch catalogs"
      );
    }

    const selectedCatalog =
      catalogs.find(catalog => catalog.id === requestedCatalogId) ||
      catalogs.find(catalog =>
        context.credentials.catalogIds?.includes(catalog.id)
      ) ||
      catalogs[0] ||
      null;

    if (!selectedCatalog) {
      return NextResponse.json({
        catalogs,
        catalogues: catalogs,
        products: [],
        selectedCatalog: null,
        selectedCatalogue: null,
        readiness,
        setupStatus: "needs_catalog",
        checks: [],
        blockingIssues: [
          {
            code: "catalog_missing",
            message:
              "No Meta product catalog is available for this WhatsApp account.",
            actionable:
              "Create or assign a Meta catalog to this business, then refresh.",
          },
        ],
        diagnostics,
        missingPermissions: [],
        requiresReconnect: false,
        error:
          "No Meta product catalog is available for this WhatsApp account.",
      });
    }

    try {
      const [products, commerceSettingsResult] = await Promise.all([
        listCatalogProducts({
          accessToken,
          catalogId: selectedCatalog.id,
          limit,
        }),
        includeCommerceSettings && context.phoneNumberId
          ? getCatalogCommerceSettings({
              accessToken,
              phoneNumberId: context.phoneNumberId,
            })
              .then(settings => ({ settings, error: null }))
              .catch(error => ({
                settings: null,
                error:
                  error instanceof Error
                    ? error.message
                    : "Commerce settings unavailable",
              }))
          : Promise.resolve({ settings: null, error: null }),
      ]);

      if (exportCsv) {
        return new Response(serializeCatalogProductsCsv(products), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="whatsapp-catalog-${selectedCatalog.id}.csv"`,
          },
        });
      }

      return NextResponse.json({
        catalogs,
        catalogues: catalogs,
        products,
        selectedCatalog,
        selectedCatalogue: selectedCatalog,
        readiness,
        commerceSettings: commerceSettingsResult.settings,
        commerceSettingsError: commerceSettingsResult.error,
        setupStatus: "ready",
        checks: [],
        blockingIssues: [],
        diagnostics,
        missingPermissions: [],
        requiresReconnect: false,
      });
    } catch (error) {
      if (isCatalogPermissionError(error)) {
        return buildMissingPermissionResponse(readiness);
      }
      return buildMetaErrorResponse(error, "Failed to fetch catalog products");
    }
  } catch (error) {
    console.error("Get catalog error:", error);
    return buildMetaErrorResponse(error, "Failed to fetch catalog data");
  }
}

export async function POST(request: Request) {
  try {
    const rawBody = await request.json();
    const action = typeof rawBody?.action === "string" ? rawBody.action : "";

    if (action === "setup") {
      const body = CatalogSetupSchema.parse(rawBody);
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can set up catalogs"
      );
      if (accessResult.error) return accessResult.error;

      const { context } = accessResult;
      const result = await runWhatsAppCatalogSetup({
        workspaceId: body.workspaceId,
        sourceId: context.sourceId,
        credentials: context.credentials as unknown as Record<string, unknown>,
        autoCreate: true,
        linkCatalog: true,
        enableCommerceSettings: true,
        saveCredentials: context.sourceId
          ? nextCredentials =>
              saveCatalogSetupCredentialsPatch(
                context.sourceId as string,
                body.workspaceId,
                context.wabaId || "",
                nextCredentials
              )
          : undefined,
      });

      return NextResponse.json(result);
    }

    if (action === "bulk_import") {
      const validated = BulkImportSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can bulk import catalog items"
      );
      if (accessResult.error) return accessResult.error;
      const parsed = body.csv
        ? parseCatalogCsvRows(body.csv)
        : {
            validItems: (body.items || []) as CatalogProductInput[],
            errors: [],
          };
      if (body.dryRun || parsed.errors.length > 0) {
        return NextResponse.json({
          success: parsed.errors.length === 0,
          dryRun: true,
          validCount: parsed.validItems.length,
          errors: parsed.errors,
        });
      }

      if (!isTemporalConfigured()) {
        return NextResponse.json(
          {
            error:
              "Temporal is required for committed catalog imports. Configure Temporal or use dry-run validation only.",
          },
          { status: 503 }
        );
      }

      const workflowEnvelope = {
        workspaceId: body.workspaceId,
        catalogId: body.catalogId,
        accessToken: accessResult.context.accessToken || "",
        items: parsed.validItems,
        batchSize: CATALOG_IMPORT_BATCH_SIZE,
        sourceId: accessResult.context.sourceId || null,
      };
      const inlinePayloadBytes = Buffer.byteLength(
        JSON.stringify(workflowEnvelope),
        "utf8"
      );
      if (inlinePayloadBytes > TEMPORAL_INLINE_WORKFLOW_PAYLOAD_BYTE_LIMIT) {
        return NextResponse.json(
          {
            error:
              "Catalog import is too large to queue inline. Split the file into smaller batches before importing.",
            maxBytes: TEMPORAL_INLINE_WORKFLOW_PAYLOAD_BYTE_LIMIT,
            payloadBytes: inlinePayloadBytes,
          },
          { status: 413 }
        );
      }

      const workflowHandle =
        await startWhatsAppCatalogImportWorkflow(workflowEnvelope);
      return NextResponse.json(
        {
          queued: true,
          importCount: parsed.validItems.length,
          workflowId: workflowHandle.workflowId,
          batchSize: CATALOG_IMPORT_BATCH_SIZE,
        },
        { status: 202 }
      );
    }

    if (action === "send_catalog_message") {
      const validated = SendCatalogMessageSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can send catalog messages",
        { requirePhoneNumber: true }
      );
      if (accessResult.error) return accessResult.error;
      const result = await sendWhatsappCatalogMessage(
        accessResult.context.phoneNumberId || "",
        accessResult.context.accessToken || "",
        { kind: "phone", value: body.to },
        body
      );
      return NextResponse.json({ success: true, result });
    }

    if (action === "send_catalog_link_message") {
      const validated = SendCatalogLinkMessageSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can send catalog links",
        { requirePhoneNumber: true }
      );
      if (accessResult.error) return accessResult.error;
      const result = await sendWhatsappCatalogLinkMessage(
        accessResult.context.phoneNumberId || "",
        accessResult.context.accessToken || "",
        { kind: "phone", value: body.to },
        body
      );
      return NextResponse.json({ success: true, result });
    }

    if (action === "send_single_product_message") {
      const validated = SendSingleProductMessageSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can send product messages",
        { requirePhoneNumber: true }
      );
      if (accessResult.error) return accessResult.error;
      const result = await sendWhatsappSingleProductMessage(
        accessResult.context.phoneNumberId || "",
        accessResult.context.accessToken || "",
        { kind: "phone", value: body.to },
        body
      );
      return NextResponse.json({ success: true, result });
    }

    if (action === "send_multi_product_message") {
      const validated = SendMultiProductMessageSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can send product list messages",
        { requirePhoneNumber: true }
      );
      if (accessResult.error) return accessResult.error;
      const result = await sendWhatsappMultiProductMessage(
        accessResult.context.phoneNumberId || "",
        accessResult.context.accessToken || "",
        { kind: "phone", value: body.to },
        body
      );
      return NextResponse.json({ success: true, result });
    }

    if (action === "send_product_carousel_message") {
      const validated = SendCarouselMessageSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can send product carousel messages",
        { requirePhoneNumber: true }
      );
      if (accessResult.error) return accessResult.error;
      const result = await sendWhatsappProductCarouselMessage(
        accessResult.context.phoneNumberId || "",
        accessResult.context.accessToken || "",
        { kind: "phone", value: body.to },
        body
      );
      return NextResponse.json({ success: true, result });
    }

    const validated = CreateProductSchema.safeParse(rawBody);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const body = validated.data;
    const catalogId = resolveCatalogId(body);
    const accessResult = await getCatalogManagerContext(
      body.workspaceId,
      "Only managers and admins can create catalog items"
    );
    if (accessResult.error) return accessResult.error;

    const result = await createCatalogProduct({
      accessToken: accessResult.context.accessToken || "",
      catalogId,
      product: body,
    });

    return NextResponse.json({
      success: true,
      product: result,
    });
  } catch (error) {
    console.error("Create catalog product error:", error);
    return buildMetaErrorResponse(error, "Failed to create catalog product");
  }
}

export async function PATCH(request: Request) {
  try {
    const rawBody = await request.json();
    if (rawBody?.action === "commerce_settings") {
      const validated = CommerceSettingsSchema.safeParse(rawBody);
      if (!validated.success) {
        return NextResponse.json(
          { error: "Validation failed", details: validated.error.flatten() },
          { status: 400 }
        );
      }
      const body = validated.data;
      const accessResult = await getCatalogManagerContext(
        body.workspaceId,
        "Only managers and admins can update commerce settings",
        { requirePhoneNumber: true }
      );
      if (accessResult.error) return accessResult.error;
      const result = await updateCatalogCommerceSettings({
        accessToken: accessResult.context.accessToken || "",
        phoneNumberId: accessResult.context.phoneNumberId || "",
        settings: {
          is_cart_enabled: body.is_cart_enabled,
          is_catalog_visible: body.is_catalog_visible,
        },
      });
      return NextResponse.json({ success: true, result });
    }

    const validated = UpdateProductSchema.safeParse(rawBody);
    if (!validated.success) {
      return NextResponse.json(
        { error: "Validation failed", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const body = validated.data;
    const catalogId = resolveCatalogId(body);
    const accessResult = await getCatalogManagerContext(
      body.workspaceId,
      "Only managers and admins can update catalog items"
    );
    if (accessResult.error) return accessResult.error;

    const result = await updateCatalogProduct({
      accessToken: accessResult.context.accessToken || "",
      catalogId,
      retailerId: body.retailer_id,
      product: buildUpdateInput(body),
    });

    return NextResponse.json({
      success: true,
      product: result,
    });
  } catch (error) {
    console.error("Update catalog product error:", error);
    return buildMetaErrorResponse(error, "Failed to update catalog product");
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get("workspaceId")?.trim();
    const catalogId = (
      searchParams.get("catalogId") ||
      searchParams.get("catalogueId") ||
      ""
    ).trim();
    const retailerId = searchParams.get("retailerId")?.trim();

    if (!workspaceId || !catalogId || !retailerId) {
      return NextResponse.json(
        { error: "workspaceId, catalogId and retailerId are required" },
        { status: 400 }
      );
    }

    const accessResult = await getCatalogManagerContext(
      workspaceId,
      "Only managers and admins can delete catalog items"
    );
    if (accessResult.error) return accessResult.error;

    const result = await deleteCatalogProduct({
      accessToken: accessResult.context.accessToken || "",
      catalogId,
      retailerId,
    });

    return NextResponse.json({
      success: true,
      product: result,
    });
  } catch (error) {
    console.error("Delete catalog product error:", error);
    return buildMetaErrorResponse(error, "Failed to delete catalog product");
  }
}
