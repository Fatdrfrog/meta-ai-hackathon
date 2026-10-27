"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  MetaCatalogProduct,
  MetaProductCatalog,
} from "@/lib/whatsapp/catalog/service";
import {
  AlertCircle,
  Download,
  Link2,
  Loader2,
  PackageSearch,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { read, utils } from "xlsx";

const AVAILABILITY_OPTIONS = [
  "in stock",
  "out of stock",
  "preorder",
  "available for order",
  "discontinued",
  "pending",
  "mark_as_sold",
  "mark_as_expired",
] as const;

const CONDITION_OPTIONS = [
  "new",
  "refurbished",
  "used",
  "used_like_new",
  "used_good",
  "used_fair",
  "cpo",
  "open_box_new",
] as const;

type CatalogReadiness = {
  hasWabaId?: boolean;
  hasBusinessId?: boolean;
  hasAccessToken?: boolean;
  hasPhoneNumberId?: boolean;
  fullCloudCatalogCapable?: boolean;
};

type CommerceSettings = {
  is_cart_enabled?: boolean;
  is_catalog_visible?: boolean;
  catalog_id?: string;
};

type CatalogSetupStatus =
  | "ready"
  | "checking"
  | "needs_catalog"
  | "manual_action"
  | "reconnect_required";

type CatalogSetupIssue = {
  code?: string;
  message?: string;
  actionable?: string | null;
};

type CatalogResponse = {
  catalogs?: MetaProductCatalog[];
  products?: MetaCatalogProduct[];
  selectedCatalog?: MetaProductCatalog | null;
  readiness?: CatalogReadiness;
  commerceSettings?: CommerceSettings | null;
  commerceSettingsError?: string | null;
  setupStatus?: CatalogSetupStatus;
  checks?: CatalogSetupIssue[];
  blockingIssues?: CatalogSetupIssue[];
  diagnostics?: CatalogSetupIssue[];
  catalogCreated?: boolean;
  catalogLinked?: boolean;
  missingPermissions?: string[];
  requiresReconnect?: boolean;
  error?: string;
};

type BulkImportResult = {
  success?: boolean;
  dryRun?: boolean;
  validCount?: number;
  importedCount?: number;
  queued?: boolean;
  importCount?: number;
  workflowId?: string;
  errors?: Array<{
    rowNumber: number;
    field: string;
    message: string;
  }>;
  error?: string;
};

type SendMode = "catalog" | "link" | "single" | "multi" | "carousel";

type SendFormState = {
  mode: SendMode;
  to: string;
  bodyText: string;
  headerText: string;
  footerText: string;
  businessPhoneNumber: string;
  productRetailerIds: string;
};

type ProductFormState = {
  retailer_id: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  image_url: string;
  url: string;
  brand: string;
  availability: string;
  condition: string;
  additional_image_urls: string;
  sale_price: string;
  inventory: string;
  product_type: string;
  category: string;
  google_product_category: string;
  color: string;
  size: string;
  material: string;
  gender: string;
  age_group: string;
  custom_label_0: string;
  custom_label_1: string;
  custom_label_2: string;
  custom_label_3: string;
  custom_label_4: string;
};

function makeReviewSku() {
  const suffix = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 12);
  return `ice-review-${suffix}`;
}

function makeDefaultProductForm(): ProductFormState {
  return {
    retailer_id: makeReviewSku(),
    name: "Ice Core Review Demo Product",
    description:
      "Temporary demo catalog item used to demonstrate product inventory management for Meta App Review.",
    price: "19.99",
    currency: "USD",
    image_url: "https://placehold.co/800x800.png?text=Ice+Core+Review",
    url: "https://ice-core.ai",
    brand: "Ice Core",
    availability: "in stock",
    condition: "new",
    additional_image_urls: "",
    sale_price: "",
    inventory: "",
    product_type: "Review demo",
    category: "",
    google_product_category: "",
    color: "",
    size: "",
    material: "",
    gender: "",
    age_group: "",
    custom_label_0: "app-review",
    custom_label_1: "",
    custom_label_2: "",
    custom_label_3: "",
    custom_label_4: "",
  };
}

function makeDefaultSendForm(): SendFormState {
  return {
    mode: "catalog",
    to: "",
    bodyText: "Browse our catalog",
    headerText: "Recommended",
    footerText: "Ice Core",
    businessPhoneNumber: "",
    productRetailerIds: "",
  };
}

function parseProductPrice(product: MetaCatalogProduct) {
  if (typeof product.price === "string") {
    const match = product.price.match(/^(\d+(?:\.\d{1,2})?)\s+([A-Z]{3})$/i);
    if (match) {
      return {
        price: match[1],
        currency: match[2].toUpperCase(),
      };
    }
    return {
      price: product.price,
      currency: product.currency || "USD",
    };
  }

  if (typeof product.price === "number") {
    return {
      price: (product.price / 100).toFixed(2),
      currency: product.currency || "USD",
    };
  }

  return {
    price: "",
    currency: product.currency || "USD",
  };
}

function makeEditForm(product: MetaCatalogProduct): ProductFormState {
  const parsedPrice = parseProductPrice(product);

  return {
    retailer_id: product.retailer_id || product.id || "",
    name: product.name || "",
    description: product.description || "",
    price: parsedPrice.price,
    currency: parsedPrice.currency,
    image_url: product.image_url || "",
    url: product.url || "",
    brand: product.brand || "",
    availability: product.availability || "in stock",
    condition: product.condition || "new",
    additional_image_urls: (product.additional_image_urls || []).join("\n"),
    sale_price:
      product.sale_price === undefined || product.sale_price === null
        ? ""
        : String(product.sale_price),
    inventory:
      product.inventory === undefined || product.inventory === null
        ? ""
        : String(product.inventory),
    product_type: product.product_type || "",
    category: product.category || "",
    google_product_category: product.google_product_category || "",
    color: product.color || "",
    size: product.size || "",
    material: product.material || "",
    gender: product.gender || "",
    age_group: product.age_group || "",
    custom_label_0: product.custom_label_0 || "",
    custom_label_1: product.custom_label_1 || "",
    custom_label_2: product.custom_label_2 || "",
    custom_label_3: product.custom_label_3 || "",
    custom_label_4: product.custom_label_4 || "",
  };
}

function getProductKey(product: MetaCatalogProduct) {
  return product.retailer_id || product.id || "";
}

function formatDate(value?: string) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

function formatPrice(product: MetaCatalogProduct) {
  if (product.price === undefined || product.price === null) return "-";
  if (typeof product.price === "string") return product.price;
  const amount = (product.price / 100).toFixed(2);
  return product.currency ? `${amount} ${product.currency}` : amount;
}

function toApiPayload(form: ProductFormState) {
  const additionalImageUrls = form.additional_image_urls
    .split(/[\n,;|]/)
    .map(value => value.trim())
    .filter(Boolean);

  return {
    retailer_id: form.retailer_id.trim(),
    name: form.name.trim(),
    description: form.description.trim(),
    price: form.price.trim(),
    currency: form.currency.trim().toUpperCase(),
    image_url: form.image_url.trim(),
    url: form.url.trim(),
    brand: form.brand.trim() || undefined,
    availability: form.availability,
    condition: form.condition,
    additional_image_urls:
      additionalImageUrls.length > 0 ? additionalImageUrls : undefined,
    sale_price: form.sale_price.trim() || undefined,
    inventory: form.inventory.trim() || undefined,
    product_type: form.product_type.trim() || undefined,
    category: form.category.trim() || undefined,
    google_product_category: form.google_product_category.trim() || undefined,
    color: form.color.trim() || undefined,
    size: form.size.trim() || undefined,
    material: form.material.trim() || undefined,
    gender: form.gender.trim() || undefined,
    age_group: form.age_group.trim() || undefined,
    custom_label_0: form.custom_label_0.trim() || undefined,
    custom_label_1: form.custom_label_1.trim() || undefined,
    custom_label_2: form.custom_label_2.trim() || undefined,
    custom_label_3: form.custom_label_3.trim() || undefined,
    custom_label_4: form.custom_label_4.trim() || undefined,
  };
}

function parseProductRetailerIds(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function StatusPill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warning" | "danger";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700",
        tone === "warning" && "bg-amber-500/10 text-amber-700",
        tone === "danger" && "bg-destructive/10 text-destructive",
        tone === "muted" && "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

function getReviewTone(status?: string): "muted" | "ok" | "warning" | "danger" {
  const normalized = String(status || "").toLowerCase();
  if (normalized.includes("reject")) return "danger";
  if (normalized.includes("approve") || normalized.includes("active")) {
    return "ok";
  }
  if (normalized.includes("pending") || normalized.includes("review")) {
    return "warning";
  }
  return "muted";
}

interface WhatsAppCatalogManagerProps {
  workspaceId: string;
}

export function WhatsAppCatalogManager({
  workspaceId,
}: WhatsAppCatalogManagerProps) {
  const [catalogs, setCatalogs] = useState<MetaProductCatalog[]>([]);
  const [products, setProducts] = useState<MetaCatalogProduct[]>([]);
  const [selectedCatalog, setSelectedCatalog] =
    useState<MetaProductCatalog | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [readiness, setReadiness] = useState<CatalogReadiness | null>(null);
  const [commerceSettings, setCommerceSettings] =
    useState<CommerceSettings | null>(null);
  const [commerceSettingsError, setCommerceSettingsError] = useState<
    string | null
  >(null);
  const [setupStatus, setSetupStatus] =
    useState<CatalogSetupStatus>("checking");
  const [blockingIssues, setBlockingIssues] = useState<CatalogSetupIssue[]>([]);
  const [diagnostics, setDiagnostics] = useState<CatalogSetupIssue[]>([]);
  const [missingPermissions, setMissingPermissions] = useState<string[]>([]);
  const [requiresReconnect, setRequiresReconnect] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [bulkCsv, setBulkCsv] = useState("");
  const [bulkResult, setBulkResult] = useState<BulkImportResult | null>(null);
  const [sendForm, setSendForm] = useState<SendFormState>(() =>
    makeDefaultSendForm()
  );
  const [createForm, setCreateForm] = useState<ProductFormState>(() =>
    makeDefaultProductForm()
  );
  const [editForm, setEditForm] = useState<ProductFormState>(() =>
    makeDefaultProductForm()
  );
  const [productToDelete, setProductToDelete] =
    useState<MetaCatalogProduct | null>(null);

  const loadCatalog = useCallback(
    async (catalogId?: string) => {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          workspaceId,
          limit: "200",
          includeCommerceSettings: "1",
        });
        const selectedId = catalogId || selectedCatalogId;
        if (selectedId) {
          params.set("catalogId", selectedId);
        }

        const response = await fetch(
          `/api/whatsapp/catalog?${params.toString()}`,
          { cache: "no-store" }
        );
        const data = (await response
          .json()
          .catch(() => null)) as CatalogResponse | null;

        if (!response.ok) {
          throw new Error(data?.error || "Failed to load catalog data");
        }

        setCatalogs(Array.isArray(data?.catalogs) ? data.catalogs : []);
        setProducts(Array.isArray(data?.products) ? data.products : []);
        setSelectedCatalog(data?.selectedCatalog || null);
        setSelectedCatalogId(data?.selectedCatalog?.id || selectedId || "");
        setReadiness(data?.readiness || null);
        setCommerceSettings(data?.commerceSettings || null);
        setCommerceSettingsError(data?.commerceSettingsError || null);
        setSetupStatus(data?.setupStatus || "ready");
        setBlockingIssues(data?.blockingIssues || []);
        setDiagnostics(data?.diagnostics || []);
        setMissingPermissions(data?.missingPermissions || []);
        setRequiresReconnect(Boolean(data?.requiresReconnect));
        setError(data?.error || null);
      } catch (loadError) {
        const message =
          loadError instanceof Error
            ? loadError.message
            : "Failed to load catalog data";
        setSetupStatus("manual_action");
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [selectedCatalogId, workspaceId]
  );

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const runSetupChecks = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      try {
        setActionLoading("setup");
        setSetupStatus("checking");
        if (!silent) {
          setError(null);
        }

        const response = await fetch("/api/whatsapp/catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "setup",
            workspaceId,
          }),
        });
        const data = (await response
          .json()
          .catch(() => null)) as CatalogResponse | null;

        if (!response.ok) {
          throw new Error(data?.error || "Failed to run catalog setup");
        }

        setSetupStatus(data?.setupStatus || "ready");
        setBlockingIssues(data?.blockingIssues || []);
        setDiagnostics(data?.diagnostics || []);
        setMissingPermissions(data?.missingPermissions || []);
        setRequiresReconnect(Boolean(data?.requiresReconnect));

        if (!silent) {
          if (data?.setupStatus === "ready") {
            toast.success("Catalog setup completed");
          } else if (data?.setupStatus === "manual_action") {
            toast.message("Manual Meta action required");
          }
        }

        await loadCatalog(data?.selectedCatalog?.id || selectedCatalogId);
      } catch (setupError) {
        const message =
          setupError instanceof Error
            ? setupError.message
            : "Failed to run catalog setup";
        setSetupStatus("manual_action");
        setError(message);
        if (!silent) {
          toast.error(message);
        }
      } finally {
        setActionLoading(null);
      }
    },
    [loadCatalog, selectedCatalogId, workspaceId]
  );

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return products;

    return products.filter(product => {
      const values = [
        product.retailer_id,
        product.id,
        product.name,
        product.description,
        product.brand,
        product.availability,
        product.condition,
        product.review_status,
        product.product_type,
        product.category,
        product.color,
        product.size,
        product.custom_label_0,
      ];
      return values.some(value =>
        typeof value === "string" ? value.toLowerCase().includes(query) : false
      );
    });
  }, [products, search]);

  const canUseCatalog =
    Boolean(readiness?.hasAccessToken) &&
    (Boolean(readiness?.hasWabaId) || Boolean(readiness?.hasBusinessId)) &&
    readiness?.fullCloudCatalogCapable !== false;
  const showReconnect =
    requiresReconnect ||
    missingPermissions.length > 0 ||
    setupStatus === "reconnect_required";
  const setupMutationRunning = actionLoading === "setup";
  const setupRunning = setupMutationRunning || setupStatus === "checking";
  const primaryBlockingIssue = blockingIssues[0] || null;
  const productActionsBlocked =
    !selectedCatalog || showReconnect || setupStatus === "manual_action";
  const selectedProductKey = productToDelete
    ? getProductKey(productToDelete)
    : "";

  const openCreateDialog = () => {
    setCreateForm(makeDefaultProductForm());
    setCreateDialogOpen(true);
  };

  const openEditDialog = (product: MetaCatalogProduct) => {
    setEditForm(makeEditForm(product));
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (product: MetaCatalogProduct) => {
    setProductToDelete(product);
    setDeleteDialogOpen(true);
  };

  const openSendDialog = (product?: MetaCatalogProduct) => {
    setSendForm({
      ...makeDefaultSendForm(),
      mode: product ? "single" : "catalog",
      productRetailerIds: product ? getProductKey(product) : "",
    });
    setSendDialogOpen(true);
  };

  const handleBulkFile = async (file: File | null) => {
    if (!file) return;

    try {
      const isSpreadsheet = /\.(xlsx|xls)$/i.test(file.name);
      if (isSpreadsheet) {
        const workbook = read(await file.arrayBuffer(), { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = sheetName ? workbook.Sheets[sheetName] : null;
        if (!sheet) {
          throw new Error("Spreadsheet has no readable sheets");
        }
        setBulkCsv(utils.sheet_to_csv(sheet));
      } else {
        setBulkCsv(await file.text());
      }
      setBulkResult(null);
    } catch (fileError) {
      toast.error(
        fileError instanceof Error
          ? fileError.message
          : "Failed to read import file"
      );
    }
  };

  const handleBulkImport = async (dryRun: boolean) => {
    if (!selectedCatalog) return;

    try {
      setActionLoading(dryRun ? "bulk-dry-run" : "bulk-import");
      const response = await fetch("/api/whatsapp/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "bulk_import",
          workspaceId,
          catalogId: selectedCatalog.id,
          dryRun,
          csv: bulkCsv,
        }),
      });
      const data = (await response
        .json()
        .catch(() => null)) as BulkImportResult | null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to import catalog products");
      }

      setBulkResult(data);
      if (dryRun) {
        toast.success(`Validated ${data?.validCount || 0} products`);
      } else if (data?.queued) {
        toast.success(`Queued ${data.importCount || 0} products`);
      } else {
        toast.success(`Imported ${data?.importedCount || 0} products`);
        await loadCatalog(selectedCatalog.id);
      }
    } catch (bulkError) {
      toast.error(
        bulkError instanceof Error
          ? bulkError.message
          : "Failed to import catalog products"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleExport = () => {
    if (!selectedCatalog) return;
    const params = new URLSearchParams({
      workspaceId,
      catalogId: selectedCatalog.id,
      export: "csv",
    });
    window.open(`/api/whatsapp/catalog?${params.toString()}`, "_blank");
  };

  const handleCommerceSettingsUpdate = async (settings: CommerceSettings) => {
    try {
      setActionLoading("commerce-settings");
      const response = await fetch("/api/whatsapp/catalog", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "commerce_settings",
          workspaceId,
          ...settings,
        }),
      });
      const data = (await response
        .json()
        .catch(() => null)) as CatalogResponse | null;

      if (!response.ok) {
        throw new Error(
          data?.error || "Commerce settings are not available for this account"
        );
      }

      toast.success("Commerce settings updated");
      await loadCatalog(selectedCatalog?.id);
    } catch (settingsError) {
      toast.error(
        settingsError instanceof Error
          ? settingsError.message
          : "Failed to update commerce settings"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleSend = async () => {
    if (!selectedCatalog) return;
    const productRetailerIds = parseProductRetailerIds(
      sendForm.productRetailerIds
    );
    const base = {
      workspaceId,
      to: sendForm.to.trim(),
    };
    const actionPayload =
      sendForm.mode === "catalog"
        ? {
            action: "send_catalog_message",
            ...base,
            bodyText: sendForm.bodyText.trim(),
            footerText: sendForm.footerText.trim() || undefined,
            thumbnailProductRetailerId: productRetailerIds[0],
          }
        : sendForm.mode === "link"
          ? {
              action: "send_catalog_link_message",
              ...base,
              businessPhoneNumber: sendForm.businessPhoneNumber.trim(),
              bodyText: sendForm.bodyText.trim(),
            }
          : sendForm.mode === "single"
            ? {
                action: "send_single_product_message",
                ...base,
                catalogId: selectedCatalog.id,
                productRetailerId: productRetailerIds[0],
                bodyText: sendForm.bodyText.trim() || undefined,
                footerText: sendForm.footerText.trim() || undefined,
              }
            : sendForm.mode === "multi"
              ? {
                  action: "send_multi_product_message",
                  ...base,
                  catalogId: selectedCatalog.id,
                  headerText: sendForm.headerText.trim(),
                  bodyText: sendForm.bodyText.trim(),
                  footerText: sendForm.footerText.trim() || undefined,
                  sections: [
                    {
                      title: "Products",
                      productRetailerIds,
                    },
                  ],
                }
              : {
                  action: "send_product_carousel_message",
                  ...base,
                  catalogId: selectedCatalog.id,
                  bodyText: sendForm.bodyText.trim(),
                  productRetailerIds,
                };

    try {
      setActionLoading("send");
      const response = await fetch("/api/whatsapp/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(actionPayload),
      });
      const data = (await response
        .json()
        .catch(() => null)) as CatalogResponse | null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to send catalog message");
      }

      toast.success("Catalog message sent");
      setSendDialogOpen(false);
    } catch (sendError) {
      toast.error(
        sendError instanceof Error
          ? sendError.message
          : "Failed to send catalog message"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreate = async () => {
    if (!selectedCatalog) return;

    try {
      setActionLoading("create");
      const response = await fetch("/api/whatsapp/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          catalogId: selectedCatalog.id,
          ...toApiPayload(createForm),
        }),
      });
      const data = (await response
        .json()
        .catch(() => null)) as CatalogResponse | null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to create product");
      }

      toast.success("Catalog product created");
      setCreateDialogOpen(false);
      await loadCatalog(selectedCatalog.id);
    } catch (createError) {
      toast.error(
        createError instanceof Error
          ? createError.message
          : "Failed to create product"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdate = async () => {
    if (!selectedCatalog) return;

    try {
      setActionLoading("update");
      const response = await fetch("/api/whatsapp/catalog", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          catalogId: selectedCatalog.id,
          ...toApiPayload(editForm),
        }),
      });
      const data = (await response
        .json()
        .catch(() => null)) as CatalogResponse | null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to update product");
      }

      toast.success("Catalog product updated");
      setEditDialogOpen(false);
      await loadCatalog(selectedCatalog.id);
    } catch (updateError) {
      toast.error(
        updateError instanceof Error
          ? updateError.message
          : "Failed to update product"
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!selectedCatalog || !selectedProductKey) return;

    try {
      setActionLoading("delete");
      const params = new URLSearchParams({
        workspaceId,
        catalogId: selectedCatalog.id,
        retailerId: selectedProductKey,
      });
      const response = await fetch(`/api/whatsapp/catalog?${params}`, {
        method: "DELETE",
      });
      const data = (await response
        .json()
        .catch(() => null)) as CatalogResponse | null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete product");
      }

      toast.success("Catalog product deleted");
      setDeleteDialogOpen(false);
      setProductToDelete(null);
      await loadCatalog(selectedCatalog.id);
    } catch (deleteError) {
      toast.error(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete product"
      );
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-5">
      <Card className="border-0 bg-transparent p-0 shadow-none">
        <CardHeader className="px-0 pb-0">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PackageSearch className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-xl tracking-tight">
                  Meta catalog
                </CardTitle>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusPill>{catalogs.length} catalogs</StatusPill>
                  <StatusPill>{products.length} products</StatusPill>
                  <StatusPill
                    tone={
                      setupStatus === "ready"
                        ? "ok"
                        : showReconnect
                          ? "danger"
                          : "warning"
                    }
                  >
                    {setupRunning
                      ? setupMutationRunning
                        ? "Setting up"
                        : "Checking"
                      : setupStatus === "ready"
                        ? "Ready"
                        : showReconnect
                          ? "Reconnect"
                          : "Setup"}
                  </StatusPill>
                  {commerceSettings ? (
                    <>
                      <StatusPill>
                        Catalog{" "}
                        {commerceSettings.is_catalog_visible === false
                          ? "off"
                          : "on"}
                      </StatusPill>
                      <StatusPill>
                        Cart{" "}
                        {commerceSettings.is_cart_enabled === false
                          ? "off"
                          : "on"}
                      </StatusPill>
                    </>
                  ) : null}
                  {selectedCatalog ? (
                    <span className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {selectedCatalog.name || selectedCatalog.id}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleExport}
                disabled={!selectedCatalog || loading}
              >
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBulkDialogOpen(true);
                  setBulkResult(null);
                }}
                disabled={productActionsBlocked}
              >
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openSendDialog()}
                disabled={productActionsBlocked}
              >
                <Send className="mr-2 h-4 w-4" />
                Send
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void runSetupChecks()}
                disabled={setupRunning || loading}
              >
                {setupRunning ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Set up catalog
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadCatalog(selectedCatalog?.id)}
                disabled={loading}
              >
                <RefreshCw
                  className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
                />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={openCreateDialog}
                disabled={productActionsBlocked}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-0 pt-1">
          {setupRunning ? (
            <Alert className="border-0 bg-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              <AlertDescription>
                {setupMutationRunning
                  ? "Setting up Meta catalog and repairing what can be handled automatically."
                  : "Checking Meta catalog setup."}
              </AlertDescription>
            </Alert>
          ) : null}

          {!canUseCatalog && !loading ? (
            <Alert className="border-0 bg-amber-500/10 text-amber-950">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {primaryBlockingIssue?.message ||
                    "Connect WhatsApp to manage catalogs."}
                </span>
                <Button asChild size="sm" variant="ghost">
                  <Link
                    href={`/panel/w/${workspaceId}/settings/integrations?type=whatsapp`}
                  >
                    Integrations
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {showReconnect ? (
            <Alert className="border-0 bg-destructive/10 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {primaryBlockingIssue?.message ||
                    "Full Cloud catalog access required."}
                  {primaryBlockingIssue?.actionable ? (
                    <span className="block text-xs opacity-80">
                      {primaryBlockingIssue.actionable}
                    </span>
                  ) : null}
                </span>
                <Button asChild size="sm" variant="ghost">
                  <Link
                    href={`/panel/w/${workspaceId}/settings/integrations?type=whatsapp`}
                  >
                    Reconnect
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {!showReconnect &&
          setupStatus === "manual_action" &&
          primaryBlockingIssue ? (
            <Alert className="border-0 bg-amber-500/10 text-amber-950">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {primaryBlockingIssue.message}
                  {primaryBlockingIssue.actionable ? (
                    <span className="block text-xs opacity-80">
                      {primaryBlockingIssue.actionable}
                    </span>
                  ) : null}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void runSetupChecks()}
                  disabled={setupRunning}
                >
                  Retry setup
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert
              className={cn(
                "border-0",
                showReconnect || setupStatus === "manual_action"
                  ? "bg-muted text-foreground"
                  : "bg-destructive/10 text-destructive"
              )}
            >
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {commerceSettingsError ? (
            <Alert className="border-0 bg-muted">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{commerceSettingsError}</AlertDescription>
            </Alert>
          ) : null}

          {diagnostics.length > 0 && !showReconnect ? (
            <Alert className="border-0 bg-muted">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {diagnostics[0]?.message ||
                  "Meta returned a non-blocking catalog diagnostic."}
              </AlertDescription>
            </Alert>
          ) : null}

          {commerceSettings ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <span className="mr-1 text-xs font-medium text-muted-foreground">
                Commerce
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void handleCommerceSettingsUpdate({
                    is_catalog_visible:
                      commerceSettings.is_catalog_visible === false,
                  })
                }
                disabled={
                  actionLoading === "commerce-settings" || productActionsBlocked
                }
              >
                {commerceSettings.is_catalog_visible === false
                  ? "Show"
                  : "Hide"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void handleCommerceSettingsUpdate({
                    is_cart_enabled: commerceSettings.is_cart_enabled === false,
                  })
                }
                disabled={
                  actionLoading === "commerce-settings" || productActionsBlocked
                }
              >
                {commerceSettings.is_cart_enabled === false
                  ? "Enable cart"
                  : "Disable cart"}
              </Button>
            </div>
          ) : null}

          <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_minmax(260px,1fr)]">
            <div>
              <Label className="sr-only">Catalog</Label>
              <Select
                value={selectedCatalogId}
                onValueChange={value => {
                  setSelectedCatalogId(value);
                  void loadCatalog(value);
                }}
                disabled={loading || catalogs.length === 0}
              >
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="Select catalog" />
                </SelectTrigger>
                <SelectContent>
                  {catalogs.map(catalog => (
                    <SelectItem key={catalog.id} value={catalog.id}>
                      {catalog.name || catalog.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="relative">
              <Label className="sr-only">Search products</Label>
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search products"
                className="bg-background pl-9"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading
            </div>
          ) : catalogs.length === 0 ? (
            <div className="rounded-lg bg-muted/40 p-10 text-center">
              <PackageSearch className="mx-auto h-8 w-8 text-muted-foreground" />
              <h3 className="mt-3 text-base font-semibold">No catalogs</h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {primaryBlockingIssue?.message ||
                  "No Meta catalog is connected to this WhatsApp business yet."}
              </p>
              {canUseCatalog ? (
                <Button
                  className="mt-4"
                  size="sm"
                  onClick={() => void runSetupChecks()}
                  disabled={setupRunning}
                >
                  {setupRunning ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Set up catalog
                </Button>
              ) : null}
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="rounded-lg bg-muted/40 p-10 text-center">
              <h3 className="text-base font-semibold">No products</h3>
              <Button
                className="mt-4"
                size="sm"
                onClick={openCreateDialog}
                disabled={productActionsBlocked}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg bg-card shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead>Product</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead>Review</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProducts.map(product => {
                    const productKey = getProductKey(product);
                    return (
                      <TableRow key={productKey || product.id}>
                        <TableCell className="min-w-[280px]">
                          <div className="flex items-center gap-3">
                            {product.image_url ? (
                              <img
                                src={product.image_url}
                                alt=""
                                className="h-11 w-11 rounded-lg bg-muted object-cover shadow-sm"
                              />
                            ) : (
                              <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-muted">
                                <PackageSearch className="h-4 w-4 text-muted-foreground" />
                              </span>
                            )}
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {product.name || productKey || product.id}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {productKey || product.id || "-"}
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                {product.brand ? (
                                  <span className="truncate text-xs text-muted-foreground">
                                    {product.brand}
                                  </span>
                                ) : null}
                                {product.url ? (
                                  <Link
                                    href={product.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Open product link"
                                    className="inline-flex items-center text-primary"
                                  >
                                    <Link2 className="h-3.5 w-3.5" />
                                  </Link>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">
                          {formatPrice(product)}
                        </TableCell>
                        <TableCell>
                          <StatusPill>{product.availability || "-"}</StatusPill>
                        </TableCell>
                        <TableCell>{product.condition || "-"}</TableCell>
                        <TableCell>
                          <StatusPill
                            tone={getReviewTone(product.review_status)}
                          >
                            {product.review_status || "unknown"}
                          </StatusPill>
                        </TableCell>
                        <TableCell>
                          {formatDate(product.updated_time)}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openSendDialog(product)}
                              disabled={!productKey || productActionsBlocked}
                            >
                              <Send className="mr-2 h-3.5 w-3.5" />
                              Send
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEditDialog(product)}
                              disabled={!productKey || productActionsBlocked}
                            >
                              <Pencil className="mr-2 h-3.5 w-3.5" />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              onClick={() => openDeleteDialog(product)}
                              disabled={!productKey || productActionsBlocked}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <ProductDialog
        title="Add product"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        form={createForm}
        setForm={setCreateForm}
        submitLabel="Create product"
        submittingLabel="Creating"
        loading={actionLoading === "create"}
        onSubmit={handleCreate}
        allowRetailerEdit
      />

      <ProductDialog
        title="Edit product"
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        form={editForm}
        setForm={setEditForm}
        submitLabel="Save changes"
        submittingLabel="Saving"
        loading={actionLoading === "update"}
        onSubmit={handleUpdate}
      />

      <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Bulk import</DialogTitle>
            <DialogDescription>CSV/XLSX or pasted rows.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="catalog-import-file">CSV or XLSX file</Label>
              <Input
                id="catalog-import-file"
                type="file"
                accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={event =>
                  void handleBulkFile(event.currentTarget.files?.[0] || null)
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="catalog-import-csv">Inventory rows</Label>
              <Textarea
                id="catalog-import-csv"
                value={bulkCsv}
                onChange={event => {
                  setBulkCsv(event.target.value);
                  setBulkResult(null);
                }}
                className="min-h-64 font-mono text-xs"
                placeholder="retailer_id,name,description,price,currency,image_url,url,inventory"
              />
            </div>
            {bulkResult ? (
              <Alert
                variant={
                  bulkResult.success || bulkResult.queued
                    ? "default"
                    : "destructive"
                }
                className="border-0"
              >
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  {bulkResult.dryRun
                    ? `Dry run found ${bulkResult.validCount || 0} valid rows.`
                    : bulkResult.queued
                      ? `Queued ${bulkResult.importCount || 0} rows.`
                      : `Imported ${bulkResult.importedCount || 0} rows.`}
                  {bulkResult.errors?.length ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {bulkResult.errors.slice(0, 8).map(error => (
                        <li
                          key={`${error.rowNumber}-${error.field}-${error.message}`}
                        >
                          Row {error.rowNumber}, {error.field}: {error.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setBulkDialogOpen(false)}
              disabled={Boolean(actionLoading)}
            >
              Close
            </Button>
            <Button
              variant="ghost"
              onClick={() => void handleBulkImport(true)}
              disabled={!bulkCsv.trim() || actionLoading === "bulk-dry-run"}
            >
              {actionLoading === "bulk-dry-run" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Validating
                </>
              ) : (
                "Dry run"
              )}
            </Button>
            <Button
              onClick={() => void handleBulkImport(false)}
              disabled={!bulkCsv.trim() || Boolean(actionLoading)}
            >
              {actionLoading === "bulk-import" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importing
                </>
              ) : (
                "Import"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SendCatalogDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        form={sendForm}
        setForm={setSendForm}
        loading={actionLoading === "send"}
        onSubmit={handleSend}
      />

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete product</DialogTitle>
            <DialogDescription>
              {selectedProductKey || "Selected product"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={actionLoading === "delete"}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={actionLoading === "delete"}
            >
              {actionLoading === "delete" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting
                </>
              ) : (
                "Delete product"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProductDialog({
  title,
  description,
  open,
  onOpenChange,
  form,
  setForm,
  submitLabel,
  submittingLabel,
  loading,
  onSubmit,
  allowRetailerEdit = false,
}: {
  title: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: ProductFormState;
  setForm: Dispatch<SetStateAction<ProductFormState>>;
  submitLabel: string;
  submittingLabel: string;
  loading: boolean;
  onSubmit: () => void;
  allowRetailerEdit?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="catalog-retailer-id"
            label="SKU / retailer ID"
            value={form.retailer_id}
            disabled={!allowRetailerEdit}
            onChange={value =>
              setForm(prev => ({ ...prev, retailer_id: value }))
            }
          />
          <Field
            id="catalog-name"
            label="Name"
            value={form.name}
            onChange={value => setForm(prev => ({ ...prev, name: value }))}
          />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="catalog-description">Description</Label>
            <Textarea
              id="catalog-description"
              value={form.description}
              onChange={event =>
                setForm(prev => ({
                  ...prev,
                  description: event.target.value,
                }))
              }
            />
          </div>
          <Field
            id="catalog-price"
            label="Price"
            value={form.price}
            onChange={value => setForm(prev => ({ ...prev, price: value }))}
          />
          <Field
            id="catalog-currency"
            label="Currency"
            value={form.currency}
            onChange={value => setForm(prev => ({ ...prev, currency: value }))}
          />
          <Field
            id="catalog-image-url"
            label="Image URL"
            value={form.image_url}
            onChange={value => setForm(prev => ({ ...prev, image_url: value }))}
          />
          <Field
            id="catalog-url"
            label="Product URL"
            value={form.url}
            onChange={value => setForm(prev => ({ ...prev, url: value }))}
          />
          <Field
            id="catalog-brand"
            label="Brand"
            value={form.brand}
            onChange={value => setForm(prev => ({ ...prev, brand: value }))}
          />
          <Field
            id="catalog-sale-price"
            label="Sale price"
            value={form.sale_price}
            onChange={value =>
              setForm(prev => ({ ...prev, sale_price: value }))
            }
          />
          <Field
            id="catalog-inventory"
            label="Stock quantity"
            value={form.inventory}
            onChange={value => setForm(prev => ({ ...prev, inventory: value }))}
          />
          <Field
            id="catalog-product-type"
            label="Product type"
            value={form.product_type}
            onChange={value =>
              setForm(prev => ({ ...prev, product_type: value }))
            }
          />
          <Field
            id="catalog-category"
            label="Category"
            value={form.category}
            onChange={value => setForm(prev => ({ ...prev, category: value }))}
          />
          <Field
            id="catalog-google-category"
            label="Google category"
            value={form.google_product_category}
            onChange={value =>
              setForm(prev => ({ ...prev, google_product_category: value }))
            }
          />
          <Field
            id="catalog-color"
            label="Color"
            value={form.color}
            onChange={value => setForm(prev => ({ ...prev, color: value }))}
          />
          <Field
            id="catalog-size"
            label="Size"
            value={form.size}
            onChange={value => setForm(prev => ({ ...prev, size: value }))}
          />
          <Field
            id="catalog-material"
            label="Material"
            value={form.material}
            onChange={value => setForm(prev => ({ ...prev, material: value }))}
          />
          <Field
            id="catalog-gender"
            label="Gender"
            value={form.gender}
            onChange={value => setForm(prev => ({ ...prev, gender: value }))}
          />
          <Field
            id="catalog-age-group"
            label="Age group"
            value={form.age_group}
            onChange={value => setForm(prev => ({ ...prev, age_group: value }))}
          />
          <Field
            id="catalog-custom-label-0"
            label="Custom label 0"
            value={form.custom_label_0}
            onChange={value =>
              setForm(prev => ({ ...prev, custom_label_0: value }))
            }
          />
          <Field
            id="catalog-custom-label-1"
            label="Custom label 1"
            value={form.custom_label_1}
            onChange={value =>
              setForm(prev => ({ ...prev, custom_label_1: value }))
            }
          />
          <Field
            id="catalog-custom-label-2"
            label="Custom label 2"
            value={form.custom_label_2}
            onChange={value =>
              setForm(prev => ({ ...prev, custom_label_2: value }))
            }
          />
          <Field
            id="catalog-custom-label-3"
            label="Custom label 3"
            value={form.custom_label_3}
            onChange={value =>
              setForm(prev => ({ ...prev, custom_label_3: value }))
            }
          />
          <Field
            id="catalog-custom-label-4"
            label="Custom label 4"
            value={form.custom_label_4}
            onChange={value =>
              setForm(prev => ({ ...prev, custom_label_4: value }))
            }
          />
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="catalog-additional-images">
              Additional image URLs
            </Label>
            <Textarea
              id="catalog-additional-images"
              value={form.additional_image_urls}
              onChange={event =>
                setForm(prev => ({
                  ...prev,
                  additional_image_urls: event.target.value,
                }))
              }
              placeholder="One URL per line"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Availability</Label>
            <Select
              value={form.availability}
              onValueChange={value =>
                setForm(prev => ({ ...prev, availability: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AVAILABILITY_OPTIONS.map(value => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Condition</Label>
            <Select
              value={form.condition}
              onValueChange={value =>
                setForm(prev => ({ ...prev, condition: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPTIONS.map(value => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {submittingLabel}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendCatalogDialog({
  open,
  onOpenChange,
  form,
  setForm,
  loading,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  form: SendFormState;
  setForm: Dispatch<SetStateAction<SendFormState>>;
  loading: boolean;
  onSubmit: () => void;
}) {
  const requiresProducts =
    form.mode === "single" || form.mode === "multi" || form.mode === "carousel";
  const productHelp =
    form.mode === "single"
      ? "One product retailer ID"
      : "Comma or newline separated product retailer IDs";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send catalog message</DialogTitle>
          <DialogDescription>
            Send a catalog item or collection.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Message type</Label>
            <Select
              value={form.mode}
              onValueChange={value =>
                setForm(prev => ({ ...prev, mode: value as SendMode }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="catalog">Catalog opener</SelectItem>
                <SelectItem value="link">Catalog link</SelectItem>
                <SelectItem value="single">Single product</SelectItem>
                <SelectItem value="multi">Multi-product</SelectItem>
                <SelectItem value="carousel">Product carousel</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Field
            id="catalog-send-to"
            label="Customer phone"
            value={form.to}
            onChange={value => setForm(prev => ({ ...prev, to: value }))}
          />
          {form.mode === "link" ? (
            <Field
              id="catalog-business-phone"
              label="Business phone"
              value={form.businessPhoneNumber}
              onChange={value =>
                setForm(prev => ({ ...prev, businessPhoneNumber: value }))
              }
            />
          ) : null}
          {form.mode === "multi" ? (
            <Field
              id="catalog-send-header"
              label="Header"
              value={form.headerText}
              onChange={value =>
                setForm(prev => ({ ...prev, headerText: value }))
              }
            />
          ) : null}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="catalog-send-body">Body text</Label>
            <Textarea
              id="catalog-send-body"
              value={form.bodyText}
              onChange={event =>
                setForm(prev => ({ ...prev, bodyText: event.target.value }))
              }
            />
          </div>
          {form.mode !== "link" ? (
            <Field
              id="catalog-send-footer"
              label="Footer"
              value={form.footerText}
              onChange={value =>
                setForm(prev => ({ ...prev, footerText: value }))
              }
            />
          ) : null}
          {requiresProducts || form.mode === "catalog" ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="catalog-send-products">
                Product retailer IDs
              </Label>
              <Textarea
                id="catalog-send-products"
                value={form.productRetailerIds}
                onChange={event =>
                  setForm(prev => ({
                    ...prev,
                    productRetailerIds: event.target.value,
                  }))
                }
                placeholder={productHelp}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Sending
              </>
            ) : (
              "Send message"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}
