"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import useSWR from "swr";
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  ShoppingCart,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type CommerceCartStatus =
  | "active"
  | "checkout_started"
  | "completed"
  | "suppressed"
  | "expired";

export type WebWidgetCommerceSettingsData = {
  enabled: boolean;
  whatsappSourceId: string | null;
  shopifyShopDomain: string | null;
  hasWebhookSecret: boolean;
  hasShopifyWebhookSecret: boolean;
  whatsappSources: Array<{ id: string; name: string }>;
  webhookUrl: string;
  shopifyWebhookUrl: string | null;
  tildaWebhookUrl: string | null;
  lastEventAt: string | null;
  recentCarts: Array<{
    cartId: string;
    status: CommerceCartStatus | string;
    updatedAt: string;
    linked: boolean;
  }>;
};

type Props = {
  workspaceId: string;
  sourceId: string;
  clientKey: string;
  widgetUrl: string;
  disabled?: boolean;
};

const RECOVERY_TEMPLATE_EXAMPLE = `Button URL: https://www.airi.chat/r/cart/{{1}}
Button value: cart.recovery_token

Other values:
cart.recovery_url
cart.total
cart.currency
cart.items
cart.item_count`;

const fetchSettings = async (
  url: string
): Promise<WebWidgetCommerceSettingsData> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("load_failed");
  return response.json();
};

type SnippetKind = "javascript" | "gtm" | "shopify" | "tilda";

function snippetFor(
  kind: SnippetKind,
  { clientKey, widgetUrl }: Pick<Props, "clientKey" | "widgetUrl">
) {
  const adapterUrl = `${widgetUrl.replace(/\/$/, "")}/commerce-adapters.js`;
  if (kind === "gtm") {
    return `<script src=${JSON.stringify(adapterUrl)}></script>
<script>
window.dataLayer = window.dataLayer || [];
window.airiGtmCartTracking = AiriCommerceAdapters.installGtmCommerceAdapter({
  commerce: {
    track: (type, payload) => window.AiriChat.track(type, payload)
  },
  dataLayer: window.dataLayer,
  processExisting: true,
  onError: error => console.warn("Cart event rejected", error.message)
});

// Every mapped GA4 event must include a stable airi.cartId,
// one currency, and the complete current ecommerce.items array.
window.dataLayer.push({
  event: "begin_checkout",
  event_id: "checkout-51:started",
  airi: {
    cartId: "cart-8b1",
    checkoutId: "checkout-51",
    recoveryUrl: "https://shop.example/cart/restore/cart-8b1"
  },
  ecommerce: {
    currency: "USD",
    items: [{ item_id: "sku-123", item_name: "Green shirt", quantity: 2, price: 29.5 }]
  }
});
</script>`;
  }
  if (kind === "shopify") {
    return `// Theme or theme app extension, after the Airi widget:
<script src=${JSON.stringify(adapterUrl)}></script>
<script>
window.airiShopifyStorefrontBridge =
  AiriCommerceAdapters.installShopifyStorefrontBridge({
    analytics: window.Shopify.analytics,
    cartJsonUrl: window.Shopify.routes.root + "cart.js",
    onError: error => console.warn("Shopify cart snapshot rejected", error.message)
  });
</script>

// Shopify custom pixel:
// First paste the contents of ${adapterUrl}, then add:
const airiShopifyPixel =
  await AiriCommerceAdapters.installShopifyPixelCommerceAdapter({
    analytics,
    browser,
    init,
    clientKey: ${JSON.stringify(clientKey)},
    storefrontOrigin: "https://YOUR-STORE.example",
    apiUrl: "https://www.airi.chat/api/widget",
    onError: error => console.warn("Shopify cart event rejected", error.message)
  });`;
  }
  if (kind === "tilda") {
    return `<script src=${JSON.stringify(adapterUrl)}></script>
<script>
let latestAiriTildaCart = null;

const tildaCartAdapter = AiriCommerceAdapters.installTildaCommerceAdapter({
  commerce: {
    track: (type, payload) => window.AiriChat.track(type, payload)
  },
  forms: document.querySelectorAll(".js-form-proccess"),
  getCartSnapshot: () => {
    if (!latestAiriTildaCart) throw new Error("No Tilda cart snapshot yet");
    return latestAiriTildaCart;
  },
  onError: error => console.warn("Tilda cart event rejected", error.message)
});

// Call this from your supported cart/GTM hook after every cart change.
window.trackAiriTildaCart = (fullSnapshot, immutableEventId) => {
  latestAiriTildaCart = fullSnapshot;
  tildaCartAdapter.trackCartSnapshot(immutableEventId);
};
</script>`;
  }
  return `window.AiriChat = window.AiriChat || function () {
  (window.AiriChat.q = window.AiriChat.q || []).push(arguments);
};

window.AiriChat("track", "cart_updated", {
  eventId: "cart-8b1:revision-12",
  cartId: cart.id,
  currency: cart.currency,
  recoveryUrl: cart.checkoutUrl,
  items: cart.items.map(item => ({
    id: item.variantId || item.productId,
    name: item.name,
    quantity: item.quantity,
    price: item.unitPrice
  }))
});`;
}

export function WebWidgetCommerceSettings(props: Props) {
  return <CommerceSettings key={props.sourceId} {...props} />;
}

function CommerceSettings({
  workspaceId,
  sourceId,
  clientKey,
  widgetUrl,
  disabled = false,
}: Props) {
  const t = useTranslations("WebWidgetIntegration.commerce");
  const locale = useLocale();
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}/commerce`;
  const { data, error, isLoading, mutate } = useSWR<WebWidgetCommerceSettingsData>(
    disabled ? null : url,
    fetchSettings
  );
  const [enabled, setEnabled] = useState(() => data?.enabled ?? false);
  const [whatsappSourceId, setWhatsappSourceId] = useState<string | null>(
    () => data?.whatsappSourceId ?? null
  );
  const [shopifyShopDomain, setShopifyShopDomain] = useState(
    () => data?.shopifyShopDomain ?? ""
  );
  const [shopifyWebhookSecret, setShopifyWebhookSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"save" | "rotate" | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setWhatsappSourceId(data.whatsappSourceId);
    setShopifyShopDomain(data.shopifyShopDomain ?? "");
  }, [data]);

  const hasWhatsAppSource = Boolean(data?.whatsappSources.length);
  const saveDisabled =
    disabled ||
    pendingAction !== null ||
    (enabled && (!hasWhatsAppSource || !whatsappSourceId));

  const save = async () => {
    if (saveDisabled) return;
    setPendingAction("save");
    setActionError(null);
    setSaved(false);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          enabled,
          whatsappSourceId,
          shopifyShopDomain: shopifyShopDomain.trim() || null,
          ...(shopifyWebhookSecret
            ? { shopifyWebhookSecret }
            : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setActionError(t("saveFailed"));
        return;
      }
      const settings = { ...body };
      Reflect.deleteProperty(settings, "webhookSecret");
      await mutate(settings, { revalidate: false });
      setShopifyWebhookSecret("");
      setSaved(true);
    } catch {
      setActionError(t("saveFailed"));
    } finally {
      setPendingAction(null);
    }
  };

  const rotateSecret = async () => {
    if (disabled || pendingAction !== null) return;
    setPendingAction("rotate");
    setActionError(null);
    setSaved(false);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rotate_secret" }),
      });
      const body = await response.json();
      if (!response.ok || typeof body.webhookSecret !== "string") {
        setActionError(t("rotateFailed"));
        return;
      }
      const { webhookSecret: secret, ...settings } = body;
      setWebhookSecret(secret);
      setCopied(null);
      await mutate(settings, { revalidate: false });
    } catch {
      setActionError(t("rotateFailed"));
    } finally {
      setPendingAction(null);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setActionError(t("copyFailed"));
    }
  };

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t("unknownTime") : dateFormatter.format(date);
  };
  const knownCartStatuses = new Set([
    "active",
    "cart",
    "checkout",
    "checkout_started",
    "closed",
    "completed",
    "ordered",
    "paid",
    "purchase_reported",
    "suppressed",
    "expired",
  ]);
  const formatCartStatus = (status: string) =>
    knownCartStatuses.has(status)
      ? t(`cartStatus.${status}` as never)
      : status.replaceAll("_", " ");
  const readiness = !data?.enabled
    ? "disabled"
    : data.lastEventAt
      ? "receiving"
      : "waiting";

  return (
    <section
      aria-label={t("title")}
      aria-busy={pendingAction !== null}
      className="min-w-0 space-y-4 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <ShoppingCart className="size-4 text-muted-foreground" aria-hidden="true" />
            <h3 className="font-medium">{t("title")}</h3>
            {data ? <Badge variant="outline">{t(`status.${readiness}`)}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          {data?.lastEventAt ? (
            <p className="text-xs text-muted-foreground">
              {t("lastEvent", { date: formatDate(data.lastEventAt) })}
            </p>
          ) : null}
        </div>
        {data ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={`commerce-enabled-${sourceId}`}>{t("enabled")}</Label>
            <Switch
              id={`commerce-enabled-${sourceId}`}
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={disabled || pendingAction !== null || (!enabled && !hasWhatsAppSource)}
            />
          </div>
        ) : null}
      </div>

      {!disabled && isLoading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t("loading")}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("loadFailed")}</span>
            <Button size="sm" variant="outline" onClick={() => void mutate()}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <p role="status" className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
          <Check className="size-4" aria-hidden="true" />
          {t("saved")}
        </p>
      ) : null}

      {data ? (
        <>
          {!hasWhatsAppSource ? (
            <Alert>
              <AlertDescription>{t("whatsappRequired")}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`commerce-whatsapp-${sourceId}`}>{t("whatsappSource")}</Label>
              <Select
                value={whatsappSourceId ?? ""}
                onValueChange={setWhatsappSourceId}
                disabled={disabled || pendingAction !== null || !hasWhatsAppSource}
              >
                <SelectTrigger id={`commerce-whatsapp-${sourceId}`} className="w-full">
                  <SelectValue placeholder={t("selectWhatsAppSource")} />
                </SelectTrigger>
                <SelectContent>
                  {data.whatsappSources.map(source => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("whatsappHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`shopify-domain-${sourceId}`}>{t("shopifyDomain")}</Label>
              <Input
                id={`shopify-domain-${sourceId}`}
                value={shopifyShopDomain}
                onChange={event => setShopifyShopDomain(event.target.value)}
                placeholder="store.myshopify.com"
                disabled={disabled || pendingAction !== null}
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{t("shopifyDomainHint")}</p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor={`shopify-secret-${sourceId}`}>{t("shopifySecret")}</Label>
              <Input
                id={`shopify-secret-${sourceId}`}
                type="password"
                value={shopifyWebhookSecret}
                onChange={event => setShopifyWebhookSecret(event.target.value)}
                placeholder={data.hasShopifyWebhookSecret ? t("secretConfigured") : t("shopifySecretPlaceholder")}
                disabled={disabled || pendingAction !== null}
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">{t("shopifySecretHint")}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={saveDisabled}>
              {pendingAction === "save" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {t("save")}
            </Button>
            <Button variant="outline" onClick={() => void rotateSecret()} disabled={disabled || pendingAction !== null}>
              {pendingAction === "rotate" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}
              {t(data.hasWebhookSecret ? "rotateSecret" : "createSecret")}
            </Button>
          </div>

          {webhookSecret ? (
            <CopyField
              id={`commerce-secret-${sourceId}`}
              label={t("webhookSecret")}
              value={webhookSecret}
              copied={copied === "webhook-secret"}
              onCopy={() => void copy("webhook-secret", webhookSecret)}
              copyLabel={t("copy")}
              copiedLabel={t("copied")}
              description={t("secretOnce")}
            />
          ) : null}

          <div className="space-y-3 border-t pt-4">
            <div>
              <h4 className="text-sm font-medium">{t("webhookTitle")}</h4>
              <p className="text-xs text-muted-foreground">{t("webhookDescription")}</p>
            </div>
            <CopyField id={`generic-webhook-${sourceId}`} label={t("genericWebhook")} value={data.webhookUrl} copied={copied === "generic-webhook"} onCopy={() => void copy("generic-webhook", data.webhookUrl)} copyLabel={t("copy")} copiedLabel={t("copied")} />
            {data.shopifyWebhookUrl ? (
              <CopyField id={`shopify-webhook-${sourceId}`} label={t("shopifyWebhook")} value={data.shopifyWebhookUrl} copied={copied === "shopify-webhook"} onCopy={() => void copy("shopify-webhook", data.shopifyWebhookUrl!)} copyLabel={t("copy")} copiedLabel={t("copied")} />
            ) : null}
            {data.tildaWebhookUrl ? (
              <CopyField id={`tilda-webhook-${sourceId}`} label={t("tildaWebhook")} value={data.tildaWebhookUrl} copied={copied === "tilda-webhook"} onCopy={() => void copy("tilda-webhook", data.tildaWebhookUrl!)} copyLabel={t("copy")} copiedLabel={t("copied")} description={t("tildaSecretHint")} />
            ) : null}
          </div>

          <div className="space-y-3 border-t pt-4">
            <div>
              <h4 className="text-sm font-medium">{t("trackingTitle")}</h4>
              <p className="text-xs text-muted-foreground">{t("trackingDescription")}</p>
            </div>
            <div className="min-w-0 rounded-md bg-muted p-3">
              <p className="text-xs font-medium">{t("templateVariablesTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("templateVariablesHint")}</p>
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => void copy("template-values", RECOVERY_TEMPLATE_EXAMPLE)}>
                  <Copy className="size-4" aria-hidden="true" />
                  {t(copied === "template-values" ? "copied" : "copy")}
                </Button>
              </div>
              <pre className="max-w-full overflow-auto whitespace-pre-wrap text-xs"><code style={{ display: "block", maxWidth: "100%", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{RECOVERY_TEMPLATE_EXAMPLE}</code></pre>
            </div>
            {(["javascript", "gtm", "shopify", "tilda"] as const).map(kind => (
              <details key={kind} className="min-w-0 rounded-md border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">{t(`snippets.${kind}`)}</summary>
                <div className="mt-3 min-w-0 space-y-2">
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => void copy(`snippet-${kind}`, snippetFor(kind, { clientKey, widgetUrl }))}>
                      <Copy className="size-4" aria-hidden="true" />
                      {t(copied === `snippet-${kind}` ? "copied" : "copy")}
                    </Button>
                  </div>
                  <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs"><code style={{ display: "block", maxWidth: "100%", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{snippetFor(kind, { clientKey, widgetUrl })}</code></pre>
                </div>
              </details>
            ))}
          </div>

          <div className="space-y-3 border-t pt-4">
            <h4 className="text-sm font-medium">{t("recentCarts")}</h4>
            {data.recentCarts.length ? (
              <ul className="divide-y rounded-md border">
                {data.recentCarts.map(cart => (
                  <li key={cart.cartId} className="flex min-w-0 flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium" title={cart.cartId}>{cart.cartId}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(cart.updatedAt)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{formatCartStatus(cart.status)}</Badge>
                      <Badge variant={cart.linked ? "default" : "secondary"}>{t(cart.linked ? "linked" : "notLinked")}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noRecentCarts")}</p>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function CopyField({
  id,
  label,
  value,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  description,
}: {
  id: string;
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel: string;
  copiedLabel: string;
  description?: string;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Input id={id} readOnly value={value} className="min-w-0 font-mono text-xs" />
        <Button type="button" variant="outline" onClick={onCopy} className="shrink-0">
          {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}
