import {
  CATALOG_PERMISSION,
  createBusinessOwnedProductCatalog,
  dedupeCatalogs,
  getCatalogCommerceSettings,
  getProductCatalog,
  isCatalogPermissionError,
  isWabaCatalogUnsupportedMethodError,
  linkWabaProductCatalog,
  listBusinessOwnedProductCatalogs,
  listWabaProductCatalogs,
  updateCatalogCommerceSettings,
  type CatalogCommerceSettings,
  type MetaProductCatalog,
} from "@/lib/whatsapp/catalog/service";
import { normalizeWhatsAppCredentials } from "@/lib/whatsapp/credentials";
import { asWhatsAppRecord } from "@icecore/shared/lib/whatsapp/value-utils";

export type WhatsAppCatalogSetupStatus =
  | "ready"
  | "checking"
  | "needs_catalog"
  | "manual_action"
  | "reconnect_required";

export type WhatsAppCatalogSetupIssue = {
  code: string;
  message: string;
  actionable?: string | null;
};

export type WhatsAppCatalogSetupCheck = WhatsAppCatalogSetupIssue & {
  status: "passed" | "warning" | "failed" | "skipped";
};

export type WhatsAppCatalogSetupResult = {
  setupStatus: WhatsAppCatalogSetupStatus;
  checks: WhatsAppCatalogSetupCheck[];
  blockingIssues: WhatsAppCatalogSetupIssue[];
  diagnostics: WhatsAppCatalogSetupIssue[];
  missingPermissions: string[];
  catalogCreated: boolean;
  catalogLinked: boolean;
  catalogs: MetaProductCatalog[];
  selectedCatalog: MetaProductCatalog | null;
  commerceSettings: CatalogCommerceSettings | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pushCheck(
  checks: WhatsAppCatalogSetupCheck[],
  check: WhatsAppCatalogSetupCheck
) {
  checks.push(check);
}

function resolveStatus(input: {
  selectedCatalog: MetaProductCatalog | null;
  blockingIssues: WhatsAppCatalogSetupIssue[];
  missingPermissions: string[];
}): WhatsAppCatalogSetupStatus {
  if (input.missingPermissions.length > 0) return "reconnect_required";
  if (input.blockingIssues.length > 0) return "manual_action";
  if (!input.selectedCatalog) return "needs_catalog";
  return "ready";
}

async function readStoredCatalogs(params: {
  accessToken: string;
  catalogIds: string[];
  diagnostics: WhatsAppCatalogSetupIssue[];
}) {
  const results = await Promise.allSettled(
    params.catalogIds.map(catalogId =>
      getProductCatalog({
        accessToken: params.accessToken,
        catalogId,
      })
    )
  );

  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    params.diagnostics.push({
      code: "stored_catalog_unavailable",
      message: `Stored catalog ${params.catalogIds[index]} is not accessible: ${errorMessage(result.reason)}`,
    });
    return [];
  });
}

export async function runWhatsAppCatalogSetup({
  workspaceId,
  sourceId,
  credentials,
  saveCredentials,
  autoCreate = false,
  linkCatalog = false,
  enableCommerceSettings = false,
  catalogName = "airi.chat WhatsApp catalog",
}: {
  workspaceId: string;
  sourceId?: string | null;
  credentials: Record<string, unknown> | null | undefined;
  saveCredentials?: (credentials: Record<string, unknown>) => Promise<void>;
  autoCreate?: boolean;
  linkCatalog?: boolean;
  enableCommerceSettings?: boolean;
  catalogName?: string;
}): Promise<WhatsAppCatalogSetupResult> {
  void workspaceId;
  void sourceId;

  const currentCredentials = { ...asWhatsAppRecord(credentials) };
  const normalized = normalizeWhatsAppCredentials(currentCredentials);
  const checks: WhatsAppCatalogSetupCheck[] = [];
  const blockingIssues: WhatsAppCatalogSetupIssue[] = [];
  const diagnostics: WhatsAppCatalogSetupIssue[] = [];
  const missingPermissions: string[] = [];
  const accessToken = normalized.accessToken || "";

  let catalogCreated = false;
  let catalogLinked = false;
  let commerceSettings: CatalogCommerceSettings | null = null;

  if (normalized.coexistenceMode) {
    blockingIssues.push({
      code: "full_cloud_required",
      message: "WhatsApp Catalog requires a full Cloud API connection.",
      actionable: "Reconnect WhatsApp with the full Cloud API Embedded Signup.",
    });
    return {
      setupStatus: "reconnect_required",
      checks,
      blockingIssues,
      diagnostics,
      missingPermissions: [],
      catalogCreated,
      catalogLinked,
      catalogs: [],
      selectedCatalog: null,
      commerceSettings,
    };
  }

  if (!accessToken) {
    missingPermissions.push("access_token");
    blockingIssues.push({
      code: "missing_access_token",
      message: "WhatsApp access token is missing.",
      actionable: "Reconnect WhatsApp.",
    });
  }

  if (!normalized.businessId) {
    blockingIssues.push({
      code: "missing_business_id",
      message: "Meta business ID is missing from the WhatsApp connection.",
      actionable: "Reconnect WhatsApp and grant business access.",
    });
  }

  if (blockingIssues.length > 0 || !accessToken) {
    return {
      setupStatus: resolveStatus({
        selectedCatalog: null,
        blockingIssues,
        missingPermissions,
      }),
      checks,
      blockingIssues,
      diagnostics,
      missingPermissions,
      catalogCreated,
      catalogLinked,
      catalogs: [],
      selectedCatalog: null,
      commerceSettings,
    };
  }

  pushCheck(checks, {
    code: "token_available",
    status: "passed",
    message: "WhatsApp access token is available.",
  });

  const catalogReads = await Promise.allSettled([
    normalized.catalogIds?.length
      ? readStoredCatalogs({
          accessToken,
          catalogIds: normalized.catalogIds,
          diagnostics,
        })
      : Promise.resolve([]),
    normalized.businessId
      ? listBusinessOwnedProductCatalogs({
          accessToken,
          businessId: normalized.businessId,
        })
      : Promise.resolve([]),
    normalized.wabaId
      ? listWabaProductCatalogs({
          accessToken,
          wabaId: normalized.wabaId,
        })
      : Promise.resolve([]),
  ]);

  const catalogs = dedupeCatalogs(
    catalogReads.flatMap(result =>
      result.status === "fulfilled" ? result.value : []
    )
  );

  for (const result of catalogReads) {
    if (result.status !== "rejected") continue;
    if (isWabaCatalogUnsupportedMethodError(result.reason)) {
      diagnostics.push({
        code: "waba_product_catalogs_unknown_method",
        message:
          "Meta rejected the WABA product_catalogs read edge; continuing with business catalog checks.",
      });
      continue;
    }
    if (isCatalogPermissionError(result.reason)) {
      missingPermissions.push(CATALOG_PERMISSION);
      continue;
    }
    diagnostics.push({
      code: "catalog_read_failed",
      message: errorMessage(result.reason),
    });
  }

  let allCatalogs = catalogs;
  let selectedCatalog =
    allCatalogs.find(catalog => normalized.catalogIds?.includes(catalog.id)) ||
    allCatalogs[0] ||
    null;

  if (missingPermissions.length > 0 && allCatalogs.length === 0) {
    blockingIssues.push({
      code: "catalog_permission_missing",
      message: "Catalog access is missing.",
      actionable:
        "Reconnect WhatsApp after granting catalog_management and assigning the Catalogs asset.",
    });
  }

  if (!selectedCatalog && autoCreate && normalized.businessId) {
    try {
      selectedCatalog = await createBusinessOwnedProductCatalog({
        accessToken,
        businessId: normalized.businessId,
        name: catalogName,
      });
      allCatalogs = dedupeCatalogs([...allCatalogs, selectedCatalog]);
      catalogCreated = true;
    } catch (error) {
      const permissionError = isCatalogPermissionError(error);
      if (permissionError) {
        missingPermissions.push(CATALOG_PERMISSION);
      }
      blockingIssues.push({
        code: permissionError
          ? "catalog_permission_missing"
          : "catalog_create_failed",
        message: permissionError
          ? "Catalog create permission is missing."
          : `Could not auto-create a Meta catalog: ${errorMessage(error)}`,
        actionable: permissionError
          ? "Reconnect WhatsApp after granting catalog_management and assigning the Catalogs asset."
          : "Create or assign a catalog in Meta Business Manager, then refresh.",
      });
    }
  }

  if (!selectedCatalog && missingPermissions.length === 0) {
    blockingIssues.push({
      code: "catalog_missing",
      message:
        "No Meta product catalog is available for this WhatsApp account.",
      actionable:
        "Create or assign a Meta catalog to this business, then refresh.",
    });
  }

  if (selectedCatalog && linkCatalog && normalized.wabaId) {
    try {
      await linkWabaProductCatalog({
        accessToken,
        wabaId: normalized.wabaId,
        catalogId: selectedCatalog.id,
      });
      catalogLinked = true;
    } catch (error) {
      const permissionError = isCatalogPermissionError(error);
      if (permissionError) {
        missingPermissions.push(CATALOG_PERMISSION);
      }
      blockingIssues.push({
        code: permissionError
          ? "catalog_permission_missing"
          : "catalog_link_failed",
        message: permissionError
          ? "Catalog link permission is missing."
          : `Could not link the catalog to the WhatsApp account: ${errorMessage(error)}`,
        actionable: permissionError
          ? "Reconnect WhatsApp after granting catalog_management and assigning the Catalogs asset."
          : "Link the catalog to the WhatsApp Business Account in Meta, then refresh.",
      });
    }
  }

  if (selectedCatalog && normalized.phoneNumberId) {
    try {
      commerceSettings = await getCatalogCommerceSettings({
        accessToken,
        phoneNumberId: normalized.phoneNumberId,
      });

      const needsVisible = commerceSettings?.is_catalog_visible !== true;
      const needsCart = commerceSettings?.is_cart_enabled !== true;
      if (enableCommerceSettings && (needsVisible || needsCart)) {
        await updateCatalogCommerceSettings({
          accessToken,
          phoneNumberId: normalized.phoneNumberId,
          settings: {
            is_catalog_visible: true,
            is_cart_enabled: true,
          },
        });
        commerceSettings = {
          ...(commerceSettings || {}),
          is_catalog_visible: true,
          is_cart_enabled: true,
        };
      }
    } catch (error) {
      diagnostics.push({
        code: "commerce_settings_unavailable",
        message: errorMessage(error),
      });
    }
  } else if (selectedCatalog) {
    diagnostics.push({
      code: "phone_number_missing",
      message:
        "Phone number ID is missing; commerce settings were not checked.",
    });
  }

  const setupStatus = resolveStatus({
    selectedCatalog,
    blockingIssues,
    missingPermissions,
  });

  if (saveCredentials) {
    const catalogIds = selectedCatalog
      ? Array.from(
          new Set([...(normalized.catalogIds || []), selectedCatalog.id])
        )
      : normalized.catalogIds || [];
    await saveCredentials({
      ...currentCredentials,
      ...(catalogIds.length > 0 ? { catalog_ids: catalogIds } : {}),
      catalog_setup: {
        status: setupStatus,
        selected_catalog_id: selectedCatalog?.id || null,
        checked_at: new Date().toISOString(),
        catalog_created: catalogCreated,
        catalog_linked: catalogLinked,
        blocking_issue_codes: blockingIssues.map(issue => issue.code),
        diagnostic_codes: diagnostics.map(issue => issue.code),
      },
    });
  }

  return {
    setupStatus,
    checks,
    blockingIssues,
    diagnostics,
    missingPermissions: Array.from(new Set(missingPermissions)),
    catalogCreated,
    catalogLinked,
    catalogs: allCatalogs,
    selectedCatalog,
    commerceSettings,
  };
}
