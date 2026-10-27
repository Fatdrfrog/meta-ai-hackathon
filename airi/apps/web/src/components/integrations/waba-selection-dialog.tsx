"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { getFreePlanUpsellLink } from "@/components/limits/free-plan-upsell";
import { cn } from "@/lib/utils";
import {
  asNullableRecord,
  readStringField,
} from "@icecore/shared/lib/value-utils";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Phone,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type ConnectFailure =
  | { kind: "reauthorization" }
  | {
      kind: "phone_conflict";
      phoneNumberId: string;
      sourceId: string;
      workspaceId: string;
      workspaceName: string;
    }
  | { kind: "channel_limit"; trialExpired: boolean }
  | { kind: "flow_rebind_blocked" }
  | { kind: "generic" };

/**
 * Maps a failed select-waba or source save response to a UI state. Server
 * text is English and codes are internal, so neither is ever shown. The
 * channel-limit and Flow-rebind codes mirror server-only constants
 * (COMPANY_CHANNEL_LIMIT_EXCEEDED_CODE, ManagedWhatsAppFlowSourceRebindError).
 */
function readConnectFailure(
  status: number,
  payload: Record<string, unknown> | null
): ConnectFailure {
  const code =
    readStringField(payload, "code") || readStringField(payload, "error");
  if (code === "reauthorization_required") return { kind: "reauthorization" };
  if (code === "phone_already_connected") {
    const conflict = asNullableRecord(payload?.conflict);
    return {
      kind: "phone_conflict",
      phoneNumberId: readStringField(conflict, "phone_number_id"),
      sourceId: readStringField(conflict, "source_id"),
      workspaceId: readStringField(conflict, "workspace_id"),
      workspaceName: readStringField(conflict, "workspace_name"),
    };
  }
  if (code === "company_channel_limit_exceeded" || status === 402) {
    return {
      kind: "channel_limit",
      trialExpired: asNullableRecord(payload?.limit)?.trialExpired === true,
    };
  }
  if (code === "WHATSAPP_FLOW_SOURCE_REBIND_BLOCKED") {
    return { kind: "flow_rebind_blocked" };
  }
  return { kind: "generic" };
}

async function readJsonRecord(res: Response) {
  return asNullableRecord(await res.json().catch(() => null));
}

interface PhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
  ownership?: {
    status: "available" | "current_workspace" | "other_workspace";
    source_id?: string;
    workspace_id?: string;
    workspace_name?: string;
  };
}

interface WABAWithPhones {
  waba: {
    id: string;
    name?: string;
    currency?: string;
    timezone_id?: string;
    account_review_status?: string;
  };
  phoneNumbers: PhoneNumber[];
  accountType: "owned" | "client";
  businessId: string;
  businessName: string;
}

interface WABASelectionPanelProps {
  /** An Embedded Signup selection; its token lives in a server-side session. */
  selectionSession?: boolean;
  workspaceId: string;
  onCancel: () => void;
  onSuccess?: () => void;
  initialSelectedWabaId?: string | null;
  businessId?: string | null;
  catalogIds?: string[];
  embeddedSignupEvent?: string | null;
  embeddedSignupFlow?: "cloud_api" | "coexistence" | null;
  /** The user started Embedded Signup to move a Business app number to Cloud API. */
  upgradeIntent?: boolean;
}

export function WABASelectionPanel({
  selectionSession = false,
  workspaceId,
  onCancel,
  onSuccess,
  initialSelectedWabaId,
  businessId,
  catalogIds = [],
  embeddedSignupEvent,
  embeddedSignupFlow,
  upgradeIntent = false,
}: WABASelectionPanelProps) {
  const t = useTranslations("WABASelection");
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [wabas, setWabas] = useState<WABAWithPhones[]>([]);
  const [selectedWabaId, setSelectedWabaId] = useState("");
  const [selectedPhoneId, setSelectedPhoneId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [errorKind, setErrorKind] = useState<
    "generic" | "reauthorization_required" | "session_expired" | null
  >(null);
  // The plan limit doesn't end the session: the list stays, and Connect can be
  // retried after a channel is freed or the plan is upgraded in another tab.
  const [planLimit, setPlanLimit] = useState<{ trialExpired: boolean } | null>(
    null
  );
  const [query, setQuery] = useState("");
  const alertRef = useRef<HTMLDivElement>(null);
  const [focusAlert, setFocusAlert] = useState(false);
  const billingHref = getFreePlanUpsellLink(workspaceId);

  // Move focus to a new alert so it scrolls into view and is read out; a
  // blocking error also disables the Connect button that had focus.
  useEffect(() => {
    if (!focusAlert || (!error && !planLimit)) return;
    alertRef.current?.focus();
    setFocusAlert(false);
  }, [error, focusAlert, planLimit]);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchWABAs() {
      setLoading(true);
      setError("");
      setErrorKind(null);

      try {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        if (selectionSession) params.set("selection_session", "1");
        const res = await fetch(
          `/api/sources/whatsapp/select-waba?${params.toString()}`,
          { signal: controller.signal }
        );

        if (!res.ok) {
          const payload = await readJsonRecord(res);
          const code = readStringField(payload, "error");
          if (res.status === 410 && code === "selection_session_expired") {
            setWabas([]);
            setError(t("sessionExpiredDescription"));
            setErrorKind("session_expired");
            return;
          }
          if (res.status === 404 && code === "no_business_found") {
            setWabas([]);
            setError("");
            setErrorKind(null);
            return;
          }
          setWabas([]);
          if (res.status === 409 && code === "reauthorization_required") {
            setError(t("reauthorizationDescription"));
            setErrorKind("reauthorization_required");
            return;
          }
          console.warn("WhatsApp account list failed", {
            status: res.status,
            code,
          });
          setError(t("fetchFailed"));
          setErrorKind("generic");
          return;
        }

        const data = (await res.json()) as { wabas?: WABAWithPhones[] };
        const nextWabas = data.wabas || [];

        if (nextWabas.length === 0) {
          setWabas([]);
          setError("");
          setErrorKind(null);
          return;
        }

        setWabas(nextWabas);

        const preferredWaba =
          nextWabas.find(item => item.waba.id === initialSelectedWabaId) ||
          nextWabas.find(item => item.phoneNumbers.length > 0) ||
          nextWabas[0];
        const preferredPhone =
          preferredWaba.phoneNumbers.find(
            phone => phone.ownership?.status !== "other_workspace"
          ) || null;

        setSelectedWabaId(preferredWaba.waba.id);
        setSelectedPhoneId(preferredPhone?.id || "");
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Error fetching WABAs:", err);
        setErrorKind("generic");
        setError(t("loadFailed"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void fetchWABAs();

    return () => controller.abort();
  }, [selectionSession, initialSelectedWabaId, workspaceId]);

  const selectedPhone = useMemo(() => {
    const selectedWaba = wabas.find(w => w.waba.id === selectedWabaId);
    if (!selectedWaba) return null;
    return (
      selectedWaba.phoneNumbers.find(p => p.id === selectedPhoneId) || null
    );
  }, [selectedPhoneId, selectedWabaId, wabas]);

  const visibleWabas = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return wabas;

    return wabas
      .map(item => {
        const wabaMatches = [
          item.waba.name,
          item.waba.id,
          item.businessName,
          item.businessId,
        ]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(needle));
        const phoneNumbers = item.phoneNumbers.filter(phone =>
          [
            phone.display_phone_number,
            phone.verified_name,
            phone.id,
            phone.quality_rating,
            phone.ownership?.workspace_name,
          ]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(needle))
        );

        return {
          ...item,
          phoneNumbers: wabaMatches ? item.phoneNumbers : phoneNumbers,
        };
      })
      .filter(
        item =>
          item.phoneNumbers.length > 0 ||
          item.waba.name?.toLowerCase().includes(needle) ||
          item.businessName.toLowerCase().includes(needle)
      );
  }, [query, wabas]);

  const applyConnectFailure = (
    failure: ConnectFailure,
    fallbackMessage: string
  ) => {
    switch (failure.kind) {
      case "reauthorization":
        setPlanLimit(null);
        setError(t("reauthorizationDescription"));
        setErrorKind("reauthorization_required");
        setFocusAlert(true);
        return;
      case "channel_limit":
        setPlanLimit({ trialExpired: failure.trialExpired });
        setFocusAlert(true);
        return;
      case "phone_conflict": {
        toast.error(
          t("validation.phoneAlreadyConnected", {
            workspace:
              failure.workspaceName ||
              failure.workspaceId ||
              t("anotherWorkspace"),
          })
        );
        // Mark the number as taken so the list shows where it is connected.
        const phoneId = failure.phoneNumberId || selectedPhoneId;
        setWabas(current =>
          current.map(item => ({
            ...item,
            phoneNumbers: item.phoneNumbers.map(phone =>
              phone.id === phoneId
                ? {
                    ...phone,
                    ownership: {
                      status: "other_workspace",
                      source_id: failure.sourceId || undefined,
                      workspace_id: failure.workspaceId || undefined,
                      workspace_name: failure.workspaceName || undefined,
                    },
                  }
                : phone
            ),
          }))
        );
        return;
      }
      case "flow_rebind_blocked":
        toast.error(t("connectErrors.flowRebindBlocked"));
        return;
      default:
        toast.error(fallbackMessage);
    }
  };

  const handleConnect = async () => {
    if (!selectedWabaId || !selectedPhoneId) {
      toast.error(t("validation.selectWabaAndPhone"));
      return;
    }
    if (selectedPhone?.ownership?.status === "other_workspace") {
      toast.error(
        t("validation.phoneAlreadyConnected", {
          workspace:
            selectedPhone.ownership.workspace_name ||
            selectedPhone.ownership.workspace_id ||
            t("anotherWorkspace"),
        })
      );
      return;
    }

    setPlanLimit(null);
    setConnecting(true);

    try {
      const res = await fetch("/api/sources/whatsapp/select-waba", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          waba_id: selectedWabaId,
          phone_number_id: selectedPhoneId,
          workspace_id: workspaceId,
        }),
      });

      if (!res.ok) {
        const payload = await readJsonRecord(res);
        console.warn("WhatsApp number selection failed", {
          status: res.status,
          code: readStringField(payload, "error"),
        });
        applyConnectFailure(
          readConnectFailure(res.status, payload),
          t("toast.connectFailed")
        );
        return;
      }

      const result = (await res.json()) as {
        webhook_warning?: string;
        data: {
          waba_id: string;
          phone_number_id: string;
          display_phone_number: string;
        };
      };

      if (result.webhook_warning) {
        toast.warning(result.webhook_warning);
      }

      await completeConnection(result.data);
    } catch (err) {
      console.error("Error connecting WABA:", err);
      toast.error(t("toast.connectFailed"));
    } finally {
      setConnecting(false);
    }
  };

  const completeConnection = async (data: {
    waba_id: string;
    phone_number_id: string;
    display_phone_number: string;
  }) => {
    try {
      const res = await fetch("/api/sources/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace_id: workspaceId,
          waba_id: data.waba_id,
          phone_number_id: data.phone_number_id,
          display_phone_number: data.display_phone_number,
          business_id: businessId || undefined,
          catalog_ids: catalogIds,
          embedded_signup: Boolean(embeddedSignupFlow),
          embedded_signup_event: embeddedSignupEvent || undefined,
          embedded_signup_flow: embeddedSignupFlow || undefined,
          ...(upgradeIntent ? { intent: "upgrade" } : {}),
        }),
      });

      if (!res.ok) {
        const payload = await readJsonRecord(res);
        console.warn("WhatsApp source save failed", {
          status: res.status,
          code:
            readStringField(payload, "code") ||
            readStringField(payload, "error"),
        });
        applyConnectFailure(
          readConnectFailure(res.status, payload),
          t("saveFailed")
        );
        return;
      }

      toast.success(t("toast.connectSuccess"));
      onSuccess?.();
      router.refresh();
    } catch (err) {
      console.error("Error completing connection:", err);
      toast.error(t("completeFailed"));
    }
  };

  return (
    <div className="flex max-h-[88vh] flex-col bg-background">
      <div className="px-5 pb-3 pt-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Phone className="h-4 w-4 text-muted-foreground" />
              </span>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {t("title")}
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("description")}
                </p>
              </div>
            </div>
          </div>

          <Button variant="ghost" size="sm" asChild className="shrink-0">
            <a
              href="https://business.facebook.com/settings/whatsapp-business-accounts"
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("metaBusiness")}
            </a>
          </Button>
        </div>
      </div>

      <div className="px-5 pb-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-9"
          />
        </div>
      </div>

      {/* Radix wraps content in a display:table div that grows to fit long
          names; keep the list as wide as the dialog so badges truncate. */}
      <ScrollArea className="min-h-0 flex-1 px-5 [&>[data-slot=scroll-area-viewport]>div]:block!">
        {loading ? <WABASelectionSkeleton /> : null}

        {!loading && error ? (
          <Alert
            ref={alertRef}
            tabIndex={-1}
            variant="destructive"
            className="bg-destructive/5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AlertCircle />
            <AlertTitle className="line-clamp-none">
              {errorKind === "reauthorization_required"
                ? t("reauthorizationTitle")
                : errorKind === "session_expired"
                  ? t("sessionExpiredTitle")
                  : t("errorTitle")}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{error}</p>
              {errorKind === "reauthorization_required" ||
              errorKind === "session_expired" ? (
                <Button type="button" variant="outline" size="sm" onClick={onCancel}>
                  {t("reauthorizationAction")}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {!loading && !error && planLimit ? (
          <Alert
            ref={alertRef}
            tabIndex={-1}
            className="mb-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <AlertCircle />
            <AlertTitle className="line-clamp-none">
              {t("connectErrors.channelLimitTitle")}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>
                {t(
                  planLimit.trialExpired
                    ? "connectErrors.trialExpiredDescription"
                    : "connectErrors.channelLimitDescription"
                )}
              </p>
              {billingHref ? (
                <Button asChild variant="outline" size="sm">
                  {/* A new tab keeps this selection session for the retry. */}
                  <a href={billingHref} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-2 h-4 w-4" />
                    {t("connectErrors.viewPlan")}
                  </a>
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {!loading && !error && wabas.length === 0 ? (
          <div className="rounded-xl bg-muted/20 p-6 text-center">
            <p className="text-sm font-medium text-foreground">
              {t("emptyTitle")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{t("noWabas")}</p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              <a
                href="https://business.facebook.com/settings/whatsapp-business-accounts"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                {t("createAccount")}
              </a>
            </Button>
          </div>
        ) : null}

        {!loading && !error && wabas.length > 0 ? (
          <RadioGroup
            className="flex flex-col gap-3 pb-4"
            value={selectedPhoneId}
            onValueChange={value => {
              const parent = wabas.find(item =>
                item.phoneNumbers.some(phone => phone.id === value)
              );
              if (parent) setSelectedWabaId(parent.waba.id);
              setSelectedPhoneId(value);
            }}
          >
            {visibleWabas.length > 0 ? (
              visibleWabas.map(wabaWithPhones => (
                <WabaPhoneGroup
                  key={wabaWithPhones.waba.id}
                  item={wabaWithPhones}
                  selectedPhoneId={selectedPhoneId}
                  selectedWabaId={selectedWabaId}
                  t={t}
                />
              ))
            ) : (
              <div className="rounded-xl bg-muted/20 p-6 text-center text-sm text-muted-foreground">
                {t("noSearchResults")}
              </div>
            )}
          </RadioGroup>
        ) : null}
      </ScrollArea>

      <div className="bg-background/95 px-5 py-4 shadow-[0_-12px_30px_-28px_hsl(var(--foreground))] backdrop-blur">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-sm text-muted-foreground">
            {selectedPhone ? (
              <span>
                {t("selected", {
                  phone: selectedPhone.display_phone_number,
                })}
              </span>
            ) : (
              <span>{t("selectionHint")}</span>
            )}
          </div>
          <div className="flex gap-2 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={connecting}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleConnect}
              disabled={
                !selectedPhoneId ||
                selectedPhone?.ownership?.status === "other_workspace" ||
                connecting ||
                loading ||
                Boolean(error)
              }
            >
              {connecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {connecting ? t("connecting") : t("connect")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WabaPhoneGroup({
  item,
  selectedPhoneId,
  selectedWabaId,
  t,
}: {
  item: WABAWithPhones;
  selectedPhoneId: string;
  selectedWabaId: string;
  t: ReturnType<typeof useTranslations<"WABASelection">>;
}) {
  const selected = item.waba.id === selectedWabaId;
  const displayName = item.waba.name || `WABA ${item.waba.id}`;

  return (
    <section
      className={cn(
        "rounded-xl bg-muted/20 p-3 transition-colors",
        selected && "bg-muted/35"
      )}
    >
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background">
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium text-foreground">
              {displayName}
            </h3>
            <p className="text-xs leading-5 text-muted-foreground">
              {item.businessName}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">
            {t("accountTypeLabel", {
              type: t(`accountType.${item.accountType}`),
            })}
          </Badge>
          {item.waba.account_review_status ? (
            <Badge variant="secondary">{item.waba.account_review_status}</Badge>
          ) : null}
        </div>
      </div>

      {item.phoneNumbers.length > 0 ? (
        <div className="grid grid-cols-1 gap-2">
          {item.phoneNumbers.map(phone => (
            <PhoneNumberOption
              key={phone.id}
              phone={phone}
              selected={selectedPhoneId === phone.id}
              t={t}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-background/70 px-3 py-2 text-sm text-muted-foreground">
          {t("noPhones")}
        </p>
      )}
    </section>
  );
}

function PhoneNumberOption({
  phone,
  selected,
  t,
}: {
  phone: PhoneNumber;
  selected: boolean;
  t: ReturnType<typeof useTranslations<"WABASelection">>;
}) {
  const connectedElsewhere = phone.ownership?.status === "other_workspace";
  const connectedHere = phone.ownership?.status === "current_workspace";
  const ownerWorkspace =
    phone.ownership?.workspace_name ||
    phone.ownership?.workspace_id ||
    t("anotherWorkspace");

  return (
    <Label
      htmlFor={`phone-${phone.id}`}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg bg-background px-3 py-3 text-sm ring-1 ring-transparent transition-colors hover:bg-muted/30",
        selected && "ring-foreground/50",
        connectedElsewhere &&
          "cursor-not-allowed opacity-60 hover:bg-background"
      )}
    >
      <RadioGroupItem
        value={phone.id}
        id={`phone-${phone.id}`}
        className="mt-1"
        disabled={connectedElsewhere}
      />
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Phone className="h-4 w-4 text-muted-foreground" />
      </span>
      {/* Badges sit under the number on narrow screens; beside it they are
          capped so a long workspace name truncates instead of hiding the
          number. */}
      <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground">
            {phone.display_phone_number}
          </span>
          {phone.verified_name ? (
            <span className="block truncate text-xs leading-5 text-muted-foreground">
              {phone.verified_name}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-wrap gap-2 sm:max-w-[50%] sm:justify-end">
          {connectedHere ? (
            <Badge variant="secondary">{t("connectedHere")}</Badge>
          ) : null}
          {connectedElsewhere ? (
            <Badge
              variant="outline"
              className="max-w-full"
              title={t("connectedElsewhere", { workspace: ownerWorkspace })}
            >
              <span className="truncate">
                {t("connectedElsewhere", { workspace: ownerWorkspace })}
              </span>
            </Badge>
          ) : null}
          {phone.code_verification_status === "VERIFIED" ? (
            <Badge variant="secondary">
              <CheckCircle2 />
              {t("verified")}
            </Badge>
          ) : null}
          {phone.quality_rating ? (
            <Badge variant="outline">
              {t("qualityRating", { rating: phone.quality_rating })}
            </Badge>
          ) : null}
        </span>
      </span>
    </Label>
  );
}

function WABASelectionSkeleton() {
  return (
    <div className="flex flex-col gap-3 pb-4">
      {[0, 1].map(index => (
        <div key={index} className="rounded-xl bg-muted/20 p-3">
          <div className="mb-3 flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}
