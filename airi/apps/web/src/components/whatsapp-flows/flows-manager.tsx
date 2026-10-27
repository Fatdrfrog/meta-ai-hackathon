"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import Masonry from "@/components/Masonry";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import {
  WHATSAPP_FLOW_CATEGORIES,
  WHATSAPP_FLOW_LIMITS,
  normalizeWhatsAppFlowCategories,
  type WhatsAppFlowCategory,
} from "@icecore/shared/types/whatsapp-flows";
import {
  createWhatsAppFlow,
  deleteWhatsAppFlow,
  fetchWhatsAppFlowDetails,
  fetchWhatsAppFlowsList,
  generateWhatsAppFlowToken,
  getWhatsAppFlowPreviewUrl,
  parseWhatsAppFlowActionPayload,
  sendWhatsAppFlowTest,
  updateWhatsAppFlow,
  type WhatsAppFlowReadiness,
  type WhatsAppFlowSummary,
} from "@/lib/whatsapp/flows/client";
import {
  AlertCircle,
  Copy,
  ExternalLink,
  FileJson,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { WhatsAppFlowEditor } from "./flow-editor";
import { FlowGalleryCard } from "./flow-gallery-card";
import { useFlowGalleryPreviews } from "./use-flow-gallery-previews";

const GALLERY_PAGE_SIZE = 12;
const GALLERY_QUERIES = ["(min-width: 1120px)", "(min-width: 760px)"];
const GALLERY_COLUMNS = [3, 2];
const galleryKey = (flow: WhatsAppFlowSummary) => flow.id;
const estimateGalleryHeight = () => 440;

const CreateFlowClientSchema = z.object({
  name: z.string().trim().min(1).max(WHATSAPP_FLOW_LIMITS.NAME_MAX_LENGTH),
  categories: z.array(z.enum(WHATSAPP_FLOW_CATEGORIES)).min(1),
  cloneFlowId: z.string().optional(),
});
const SendTestClientSchema = z.object({
  recipientPhone: z.string().min(3),
  flowToken: z.string().min(1),
  bodyText: z.string().optional(),
  flowCta: z.string().optional(),
  flowActionType: z.enum(["navigate", "data_exchange"]),
  flowActionPayload: z.string().optional(),
});
const emptyCreateForm = () => ({
  name: "",
  categories: ["OTHER"] as WhatsAppFlowCategory[],
  cloneFlowId: "",
});
interface WhatsAppFlowsManagerProps {
  workspaceId: string;
  sourceOptions: ReadonlyArray<{ id: string; label: string }>;
}
export function WhatsAppFlowsManager({
  workspaceId,
  sourceOptions,
}: WhatsAppFlowsManagerProps) {
  const [selection, setSelection] = useState<{
    workspaceId: string;
    sourceId: string;
  } | null>(null);
  const selectedSourceId =
    selection?.workspaceId === workspaceId &&
    sourceOptions.some(source => source.id === selection.sourceId)
      ? selection.sourceId
      : sourceOptions.length === 1
        ? sourceOptions[0]!.id
        : "";
  // Reset account-owned rows and dialogs synchronously, including A -> B -> A.
  const ownerKey = useTransitionOwnerKey(
    JSON.stringify([workspaceId, selectedSourceId])
  );
  return (
    <ScopedWhatsAppFlowsManager
      key={ownerKey}
      workspaceId={workspaceId}
      sourceOptions={sourceOptions}
      selectedSourceId={selectedSourceId}
      onSourceChange={sourceId => setSelection({ workspaceId, sourceId })}
    />
  );
}
function ScopedWhatsAppFlowsManager({
  workspaceId,
  sourceOptions,
  selectedSourceId,
  onSourceChange,
}: WhatsAppFlowsManagerProps & {
  selectedSourceId: string;
  onSourceChange: (sourceId: string) => void;
}) {
  const t = useTranslations("WhatsAppFlows");
  const [flows, setFlows] = useState<WhatsAppFlowSummary[]>([]);
  const [loading, setLoading] = useState(Boolean(selectedSourceId));
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<WhatsAppFlowReadiness | null>(
    null
  );
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [selectedFlow, setSelectedFlow] = useState<WhatsAppFlowSummary | null>(
    null
  );
  const [editorFlow, setEditorFlow] = useState<WhatsAppFlowSummary | null>(
    null
  );
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [visibleCount, setVisibleCount] = useState(GALLERY_PAGE_SIZE);
  const [previewRevision, setPreviewRevision] = useState(0);
  const gallery = useFlowGalleryPreviews({
    workspaceId,
    sourceId: selectedSourceId,
    revision: previewRevision,
  });
  const [sendForm, setSendForm] = useState({
    recipientPhone: "",
    flowToken: "",
    bodyText: "",
    flowCta: "Open Flow",
    flowActionType: "navigate" as "navigate" | "data_exchange",
    flowActionPayload: "",
  });
  const mountedRef = useRef(false);
  const listSequenceRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const actionInFlightRef = useRef(false);
  const actionSequenceRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listSequenceRef.current += 1;
      actionSequenceRef.current += 1;
      listAbortRef.current?.abort();
    };
  }, []);
  const loadFailedMessage = t("alerts.loadFailed");
  const loadFlows = useCallback(
    async (force = false) => {
      if (!selectedSourceId || !mountedRef.current) return;
      const sequence = ++listSequenceRef.current;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;
      const isCurrent = () =>
        mountedRef.current &&
        sequence === listSequenceRef.current &&
        !controller.signal.aborted;
      if (force) setPreviewRevision(current => current + 1);
      setLoading(true);
      setError(null);
      try {
        const result = await fetchWhatsAppFlowsList({
          workspaceId,
          sourceId: selectedSourceId,
          limit: 200,
          force,
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (result.data?.readiness) setReadiness(result.data.readiness);
        if (!result.ok)
          throw new Error(result.data?.error || loadFailedMessage);
        setFlows(Array.isArray(result.data?.flows) ? result.data.flows : []);
        setReadiness(result.data?.readiness ?? null);
      } catch (loadError) {
        if (isCurrent())
          setError(
            loadError instanceof Error ? loadError.message : loadFailedMessage
          );
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [workspaceId, selectedSourceId, loadFailedMessage]
  );
  useEffect(() => {
    void loadFlows();
  }, [loadFlows]);
  const hasCredentials =
    (readiness?.hasAccessToken ?? true) && (readiness?.hasWabaId ?? true);
  const hasPhoneNumberId = readiness?.hasPhoneNumberId ?? true;
  const busy = actionLoadingId !== null;
  const publishedCount = flows.filter(
    flow => flow.status === "PUBLISHED"
  ).length;
  const visibleFlows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return flows.filter(
      flow =>
        (statusFilter === "ALL" || flow.status === statusFilter) &&
        (!query ||
          `${flow.name ?? ""} ${flow.id}`.toLocaleLowerCase().includes(query))
    );
  }, [flows, search, statusFilter]);
  async function performAction<
    T extends { ok: boolean; data: { error?: string } | null },
  >(
    actionId: string,
    request: () => Promise<T>,
    onSuccess: (result: T) => void | Promise<void>,
    failureKey: string,
    successKey?: string
  ) {
    if (!mountedRef.current || !selectedSourceId || actionInFlightRef.current)
      return;
    actionInFlightRef.current = true;
    const sequence = ++actionSequenceRef.current;
    const isCurrent = () =>
      mountedRef.current && sequence === actionSequenceRef.current;
    setActionLoadingId(actionId);
    try {
      const result = await request();
      if (!isCurrent()) return;
      if (!result.ok) throw new Error(result.data?.error || t(failureKey));
      await onSuccess(result);
      if (isCurrent() && successKey) toast.success(t(successKey));
    } catch (actionError) {
      if (isCurrent())
        toast.error(
          actionError instanceof Error ? actionError.message : t(failureKey)
        );
    } finally {
      if (isCurrent()) {
        actionInFlightRef.current = false;
        setActionLoadingId(null);
      }
    }
  }
  const openCreateDialog = (flow?: WhatsAppFlowSummary) => {
    setCreateForm(
      flow
        ? {
            name: t("dialogs.create.copyName", { name: flow.name || flow.id }),
            categories: normalizeWhatsAppFlowCategories(flow.categories),
            cloneFlowId: flow.id,
          }
        : emptyCreateForm()
    );
    setCreateDialogOpen(true);
  };
  const handleCreateFlow = async () => {
    const parsed = CreateFlowClientSchema.safeParse(createForm);
    if (!parsed.success) {
      toast.error(t("alerts.createFailed"));
      return;
    }
    const payload = {
      workspaceId,
      sourceId: selectedSourceId,
      ...parsed.data,
      cloneFlowId: parsed.data.cloneFlowId?.trim() || undefined,
    };
    await performAction(
      "create",
      () => createWhatsAppFlow(payload),
      async result => {
        const flow = result.data?.flow;
        if (!flow?.id) throw new Error(t("alerts.createFailed"));
        setCreateDialogOpen(false);
        setCreateForm(emptyCreateForm());
        setEditorFlow({
          ...flow,
          id: flow.id,
          name: flow.name || parsed.data.name,
          status: flow.status || "DRAFT",
          categories: flow.categories || parsed.data.categories,
        });
        await loadFlows(true);
      },
      "alerts.createFailed",
      "alerts.createSuccess"
    );
  };
  const runFlowOperation = async (
    flowId: string,
    operation: "publish" | "deprecate",
    managedResolution = false
  ) => {
    if (
      operation === "deprecate" &&
      !window.confirm(
        t(
          managedResolution
            ? "alerts.resolveManagedConfirm"
            : "alerts.deprecateConfirm"
        )
      )
    )
      return;
    await performAction(
      `${operation}:${flowId}`,
      () =>
        updateWhatsAppFlow(
          operation === "deprecate"
            ? {
                workspaceId,
                sourceId: selectedSourceId,
                flowId,
                operation,
                acknowledgePreviouslySentMessagesWillStopOpening: true,
              }
            : { workspaceId, sourceId: selectedSourceId, flowId, operation }
        ),
      () => loadFlows(true),
      "alerts.actionFailed",
      "alerts.actionSuccess"
    );
  };
  const handleDeleteDraft = async (
    flowId: string,
    managedResolution = false
  ) => {
    if (
      !window.confirm(
        t(
          managedResolution
            ? "alerts.resolveManagedConfirm"
            : "alerts.deleteConfirm"
        )
      )
    )
      return;
    await performAction(
      `delete:${flowId}`,
      () =>
        deleteWhatsAppFlow({
          workspaceId,
          sourceId: selectedSourceId,
          flowId,
          acknowledgeDraftDeletion: true,
        }),
      () => loadFlows(true),
      "alerts.deleteFailed",
      "alerts.deleteSuccess"
    );
  };
  const openSendDialog = (flow: WhatsAppFlowSummary) => {
    setSelectedFlow(flow);
    setSendForm({
      recipientPhone: "",
      flowToken: generateWhatsAppFlowToken(flow.id),
      bodyText: "",
      flowCta: "Open Flow",
      flowActionType: "navigate",
      flowActionPayload: "",
    });
    setSendDialogOpen(true);
  };
  const handleSendTest = async () => {
    if (!selectedFlow) return;
    const parsed = SendTestClientSchema.safeParse(sendForm);
    if (!parsed.success) {
      toast.error(t("alerts.sendFailed"));
      return;
    }
    const actionPayload = parseWhatsAppFlowActionPayload(
      (parsed.data.flowActionPayload || "").trim()
    );
    if (!actionPayload) {
      toast.error(t("alerts.invalidPayloadJson"));
      return;
    }
    await performAction(
      `send:${selectedFlow.id}`,
      () =>
        sendWhatsAppFlowTest({
          workspaceId,
          sourceId: selectedSourceId,
          recipientPhone: parsed.data.recipientPhone,
          flowId: selectedFlow.id,
          mode: selectedFlow.status === "DRAFT" ? "draft" : undefined,
          flowToken: parsed.data.flowToken,
          bodyText: parsed.data.bodyText || undefined,
          flowCta: parsed.data.flowCta || undefined,
          flowActionType: parsed.data.flowActionType,
          flowActionPayload: actionPayload,
        }),
      () => setSendDialogOpen(false),
      "alerts.sendFailed",
      "alerts.sendSuccess"
    );
  };
  const handleOpenPreview = async (flow: WhatsAppFlowSummary) => {
    await performAction(
      `preview:${flow.id}`,
      () =>
        fetchWhatsAppFlowDetails({
          workspaceId,
          sourceId: selectedSourceId,
          flowId: flow.id,
        }),
      result => {
        const url =
          getWhatsAppFlowPreviewUrl(result.data?.flow) ||
          getWhatsAppFlowPreviewUrl(flow);
        if (!url) throw new Error(t("alerts.previewUnavailable"));
        window.open(url, "_blank", "noopener,noreferrer");
      },
      "alerts.previewFailed"
    );
  };
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {sourceOptions.length > 1 ? (
          <div className="w-full min-w-0 sm:w-64">
            <Label htmlFor="whatsapp-flow-source" className="sr-only">
              {t("sourceLabel")}
            </Label>
            <Select
              value={selectedSourceId || undefined}
              onValueChange={onSourceChange}
            >
              <SelectTrigger id="whatsapp-flow-source">
                <SelectValue placeholder={t("sourcePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map(source => (
                  <SelectItem key={source.id} value={source.id}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : sourceOptions[0] ? (
          <span className="w-full min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere] sm:w-auto sm:flex-1">
            {sourceOptions[0].label}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 gap-2">
          <Button
            variant="outline"
            className="h-10"
            onClick={() => void loadFlows(true)}
            disabled={loading || !selectedSourceId}
          >
            <RefreshCw
              className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"}
            />
            {t("refresh")}
          </Button>
          <Button
            className="h-10"
            onClick={() => openCreateDialog()}
            disabled={!hasCredentials || !selectedSourceId || busy}
          >
            <Plus className="h-4 w-4" />
            {t("createFlow")}
          </Button>
        </div>
      </div>
      {!selectedSourceId ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{t("alerts.sourceRequired")}</AlertDescription>
        </Alert>
      ) : null}
      {readiness && !hasCredentials ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("alerts.credentialsMissing")}</span>
            <Button asChild size="sm" variant="outline">
              <Link
                href={`/panel/w/${workspaceId}/settings/integrations?integration=whatsapp`}
              >
                {t("alerts.connectWhatsApp")}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {readiness && hasCredentials && !hasPhoneNumberId ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("alerts.phoneMissing")}</span>
            <Button asChild size="sm" variant="outline">
              <Link
                href={`/panel/w/${workspaceId}/messengers/upgrade-messenger`}
              >
                {t("alerts.openBadgeChecklist")}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {selectedSourceId ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-48">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              aria-label={t("searchLabel")}
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={event => {
                setSearch(event.target.value);
                setVisibleCount(GALLERY_PAGE_SIZE);
              }}
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={value => {
              setStatusFilter(value);
              setVisibleCount(GALLERY_PAGE_SIZE);
            }}
          >
            <SelectTrigger className="w-36" aria-label={t("statusFilterLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("allStatuses")}</SelectItem>
              {[
                "DRAFT",
                "PUBLISHED",
                "DEPRECATED",
                "BLOCKED",
                "THROTTLED",
                "MISSING",
              ].map(status => (
                <SelectItem key={status} value={status}>
                  {t(`statuses.${status.toLowerCase()}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {t("stats.total", { count: flows.length })} ·{" "}
            {t("stats.published", { count: publishedCount })}
          </span>
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!selectedSourceId ? null : loading ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </div>
      ) : visibleFlows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-12 text-center">
          <FileJson className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
          <p className="font-medium">
            {flows.length ? t("noMatchesTitle") : t("noFlowsTitle")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {flows.length ? t("noMatchesDescription") : t("noFlowsDescription")}
          </p>
        </div>
      ) : (
        <div role="list" aria-label={t("gallery.library")}>
          <Masonry
            items={visibleFlows.slice(0, visibleCount)}
            getKey={galleryKey}
            getHeight={estimateGalleryHeight}
            gap={16}
            minColumnWidth={320}
            queries={GALLERY_QUERIES}
            columnValues={GALLERY_COLUMNS}
            defaultColumns={1}
            duration={0.2}
            stagger={0.025}
            renderItem={flow => {
              const status = flow.status || "UNKNOWN";
              const isDraft = status === "DRAFT";
              const managed = flow.managedArtifact;
              const unavailable =
                flow.providerUnavailable || status === "MISSING";
              const issues = flow.validation_errors?.length ?? 0;
              const scenarioHref = managed?.scenarioId
                ? `/panel/w/${workspaceId}/scenarios?scenarioId=${encodeURIComponent(managed.scenarioId)}`
                : null;
              return (
                <FlowGalleryCard
                  key={`${flow.id}:${previewRevision}`}
                  flow={flow}
                  preview={gallery.get(flow.id)}
                  loadPreview={gallery.load}
                  retryPreview={gallery.retry}
                >
                  {scenarioHref ? (
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="h-10"
                    >
                      <Link href={scenarioHref}>
                        {t("actions.openScenario")}
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-10"
                      onClick={() => setEditorFlow(flow)}
                      disabled={unavailable || busy}
                    >
                      {isDraft && !managed ? (
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      ) : null}
                      {t(isDraft && !managed ? "actions.edit" : "actions.view")}
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-10 w-10"
                        aria-label={t("actions.more", {
                          name: flow.name || flow.id,
                        })}
                        disabled={busy}
                      >
                        <MoreHorizontal className="h-4 w-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={unavailable}
                        onSelect={() => void handleOpenPreview(flow)}
                      >
                        <ExternalLink />
                        {t("actions.preview")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          !hasCredentials ||
                          !hasPhoneNumberId ||
                          unavailable ||
                          !["DRAFT", "PUBLISHED", "THROTTLED"].includes(status)
                        }
                        onSelect={() => openSendDialog(flow)}
                      >
                        {t("actions.sendTest")}
                      </DropdownMenuItem>
                      {!managed ? (
                        <DropdownMenuItem
                          disabled={unavailable || !hasCredentials}
                          onSelect={() => openCreateDialog(flow)}
                        >
                          <Copy />
                          {t("actions.copy")}
                        </DropdownMenuItem>
                      ) : null}
                      {isDraft && !managed ? (
                        <DropdownMenuItem
                          disabled={
                            !hasCredentials ||
                            unavailable ||
                            issues > 0 ||
                            !flow.json_version
                          }
                          onSelect={() =>
                            void runFlowOperation(flow.id, "publish")
                          }
                        >
                          {t("actions.publish")}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled>
                        <span className="max-w-64 truncate font-mono text-xs">
                          {flow.id}
                        </span>
                      </DropdownMenuItem>
                      {isDraft && !managed ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => void handleDeleteDraft(flow.id)}
                        >
                          {t("actions.deleteDraft")}
                        </DropdownMenuItem>
                      ) : null}
                      {status === "PUBLISHED" && !managed ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            void runFlowOperation(flow.id, "deprecate")
                          }
                        >
                          {t("actions.deprecate")}
                        </DropdownMenuItem>
                      ) : null}
                      {managed?.cleanupEligibility === "ELIGIBLE" ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() =>
                            managed.suggestedResolutionKind === "draft_deleted"
                              ? void handleDeleteDraft(flow.id, true)
                              : void runFlowOperation(
                                  flow.id,
                                  "deprecate",
                                  true
                                )
                          }
                        >
                          {t("actions.resolveManaged")}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </FlowGalleryCard>
              );
            }}
          />
          {visibleCount < visibleFlows.length ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                onClick={() =>
                  setVisibleCount(count => count + GALLERY_PAGE_SIZE)
                }
              >
                {t("gallery.loadMore", {
                  count: Math.min(
                    GALLERY_PAGE_SIZE,
                    visibleFlows.length - visibleCount
                  ),
                })}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>{t("setupHint")}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <a
            className="inline-flex items-center gap-1 hover:underline"
            href="https://business.facebook.com/wa/manage/flows/"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("openMetaManager")}
            <ExternalLink className="h-3 w-3" />
          </a>
          <a
            className="inline-flex items-center gap-1 hover:underline"
            href="https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("readDocs")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
      <Dialog
        open={createDialogOpen}
        onOpenChange={open => {
          if (!busy) setCreateDialogOpen(open);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t(
                createForm.cloneFlowId
                  ? "dialogs.create.copyTitle"
                  : "dialogs.create.title"
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                createForm.cloneFlowId
                  ? "dialogs.create.copyDescription"
                  : "dialogs.create.description"
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="flow-name">{t("dialogs.create.nameLabel")}</Label>
              <Input
                id="flow-name"
                value={createForm.name}
                onChange={event =>
                  setCreateForm(prev => ({ ...prev, name: event.target.value }))
                }
                disabled={busy}
              />
            </div>
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="text-sm font-medium">
                {t("dialogs.create.categoriesLabel")}
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {WHATSAPP_FLOW_CATEGORIES.map(category => (
                  <label
                    key={category}
                    className="flex min-w-0 items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={createForm.categories.includes(category)}
                      onCheckedChange={checked =>
                        setCreateForm(prev => ({
                          ...prev,
                          categories: checked
                            ? [...prev.categories, category]
                            : prev.categories.filter(
                                value => value !== category
                              ),
                        }))
                      }
                    />
                    <span className="min-w-0">
                      {t(`categories.${category}`)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {createForm.cloneFlowId ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">
                  {t("dialogs.create.advanced")}
                </summary>
                <p className="mt-2 break-all font-mono">
                  {createForm.cloneFlowId}
                </p>
              </details>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={busy}
            >
              {t("dialogs.create.cancel")}
            </Button>
            <Button
              onClick={() => void handleCreateFlow()}
              disabled={
                busy ||
                !createForm.name.trim() ||
                createForm.categories.length === 0
              }
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("dialogs.create.submitting")}
                </>
              ) : (
                t("dialogs.create.submit")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent className="flex h-[85dvh] max-h-[85dvh] flex-col overflow-hidden sm:max-w-xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("dialogs.send.title")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.send.description", {
                flowName: selectedFlow?.name || selectedFlow?.id || "",
              })}
              <span className="mt-2 block">
                {t("dialogs.send.requirements")}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            <div className="space-y-1.5">
              <Label htmlFor="send-recipient">
                {t("dialogs.send.recipientLabel")}
              </Label>
              <Input
                id="send-recipient"
                value={sendForm.recipientPhone}
                onChange={event =>
                  setSendForm(prev => ({
                    ...prev,
                    recipientPhone: event.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="send-token">
                {t("dialogs.send.flowTokenLabel")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="send-token"
                  value={sendForm.flowToken}
                  onChange={event =>
                    setSendForm(prev => ({
                      ...prev,
                      flowToken: event.target.value,
                    }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setSendForm(prev => ({
                      ...prev,
                      flowToken: generateWhatsAppFlowToken(selectedFlow?.id),
                    }))
                  }
                >
                  {t("dialogs.send.generateToken")}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="send-body">{t("dialogs.send.bodyLabel")}</Label>
              <Input
                id="send-body"
                value={sendForm.bodyText}
                onChange={event =>
                  setSendForm(prev => ({
                    ...prev,
                    bodyText: event.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="send-cta">{t("dialogs.send.ctaLabel")}</Label>
              <Input
                id="send-cta"
                value={sendForm.flowCta}
                onChange={event =>
                  setSendForm(prev => ({
                    ...prev,
                    flowCta: event.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("dialogs.send.actionTypeLabel")}</Label>
              <Select
                value={sendForm.flowActionType}
                onValueChange={value =>
                  setSendForm(prev => ({
                    ...prev,
                    flowActionType: value as "navigate" | "data_exchange",
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="navigate">
                    {t("dialogs.send.navigate")}
                  </SelectItem>
                  <SelectItem value="data_exchange">
                    {t("dialogs.send.dataExchange")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="send-payload">
                {t("dialogs.send.payloadLabel")}
              </Label>
              <Textarea
                id="send-payload"
                value={sendForm.flowActionPayload}
                placeholder={JSON.stringify({ screen: "START" })}
                onChange={event =>
                  setSendForm(prev => ({
                    ...prev,
                    flowActionPayload: event.target.value,
                  }))
                }
              />
            </div>
          </div>

          <DialogFooter className="shrink-0">
            <Button
              variant="outline"
              onClick={() => setSendDialogOpen(false)}
              disabled={actionLoadingId === `send:${selectedFlow?.id || ""}`}
            >
              {t("dialogs.send.cancel")}
            </Button>
            <Button
              onClick={handleSendTest}
              disabled={actionLoadingId === `send:${selectedFlow?.id || ""}`}
            >
              {actionLoadingId === `send:${selectedFlow?.id || ""}` ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("dialogs.send.submitting")}
                </>
              ) : (
                t("dialogs.send.submit")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editorFlow && selectedSourceId ? (
        <WhatsAppFlowEditor
          key={`${workspaceId}:${selectedSourceId}:${editorFlow.id}`}
          workspaceId={workspaceId}
          sourceId={selectedSourceId}
          flow={editorFlow}
          onClose={() => setEditorFlow(null)}
          onSaved={flow => {
            if (!mountedRef.current) return;
            if (flow)
              setFlows(current =>
                current.map(existing =>
                  existing.id === flow.id ? { ...existing, ...flow } : existing
                )
              );
            void loadFlows(true);
          }}
        />
      ) : null}
    </div>
  );
}
