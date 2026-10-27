"use client";

import { FlowFormEditorContent } from "@/components/scenarios/builders/whatsapp/field-editor";
import { TemplatePicker } from "@/components/scenarios/builders/whatsapp/template-picker";
import { FlowInteractivePreview } from "@/components/scenarios/builders/whatsapp/flow-interactive-preview";
import { projectFlowJsonPreview } from "@/components/scenarios/builders/whatsapp/flow-json-preview";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getWhatsAppFlowPreviewUrl } from "@/lib/whatsapp/flows/client";
import {
  WHATSAPP_FLOW_CATEGORIES,
  WHATSAPP_FLOW_LIMITS,
} from "@icecore/shared/types/whatsapp-flows";
import {
  AlertCircle,
  Download,
  ExternalLink,
  Loader2,
  Save,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import {
  useWhatsAppFlowEditor,
  type WhatsAppFlowEditorProps,
} from "./use-flow-editor";

export type { WhatsAppFlowEditorProps } from "./use-flow-editor";

export function WhatsAppFlowEditor(props: WhatsAppFlowEditorProps) {
  const editor = useWhatsAppFlowEditor(props);
  const { t } = editor;
  const id = useId();
  const upload = useRef<HTMLInputElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonPreviewOpen, setJsonPreviewOpen] = useState(false);
  const previewUrl = getWhatsAppFlowPreviewUrl(editor.details);
  const disabled = Boolean(editor.busy);
  const publishBlockedReason =
    !editor.readOnly && !disabled && !editor.canPublish
      ? editor.issues.length
        ? t("editor.publishNeedsValidation")
        : editor.dirty
          ? t("editor.publishNeedsSave")
          : null
      : null;
  const documentPreview = useMemo(
    () => (editor.parsed ? projectFlowJsonPreview(editor.parsed) : null),
    [editor.parsed]
  );
  const editablePreview =
    editor.visualConfig?.flowNavigationMode !== "data_endpoint"
      ? editor.visualConfig
      : null;
  const previewConfig = editablePreview ?? documentPreview?.config;
  const renderPreview = (screenId?: string) => (
    <div className="min-w-0 space-y-3">
      {previewConfig ? (
        <FlowInteractivePreview
          config={previewConfig}
          initialScreenId={screenId}
          preview={editablePreview ? undefined : (documentPreview ?? undefined)}
          disabled={disabled}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("editor.previewUnavailable")}
        </p>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) editor.close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] w-full max-w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 data-[vaul-drawer-direction=bottom]:mx-auto data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-1rem)] sm:max-w-[80rem]"
      >
        <DialogHeader className="shrink-0 px-4 py-3 text-left sm:px-5">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="truncate">
                {editor.name || t("editor.title")}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t("editor.description")}
              </DialogDescription>
              {!editor.loading ? (
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant="secondary">{editor.details.status}</Badge>
                  {!editor.readOnly ? (
                    <span
                      role="status"
                      className="text-xs text-muted-foreground"
                    >
                      {t(
                        editor.dirty
                          ? "editor.unsaved"
                          : editor.source
                            ? "editor.saved"
                            : "editor.emptyTitle"
                      )}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={editor.close}
              disabled={disabled}
              aria-label={t("editor.close")}
            >
              <X className="size-4" />
            </Button>
          </div>
        </DialogHeader>
        {editor.loading ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {t("editor.loading")}
          </div>
        ) : editor.loadError ? (
          <div className="space-y-4 p-6">
            <Alert variant="destructive">
              <AlertDescription>{editor.loadError}</AlertDescription>
            </Alert>
            <Button variant="outline" onClick={editor.retry}>
              {t("editor.retry")}
            </Button>
          </div>
        ) : (
          <>
            <Tabs
              value={editor.mode}
              onValueChange={value =>
                editor.setMode(value as "visual" | "json")
              }
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-3 sm:px-5">
                <TabsList>
                  <TabsTrigger
                    value="visual"
                    disabled={
                      !editor.canEditVisually || editor.readOnly || disabled
                    }
                  >
                    {t("editor.visual")}
                  </TabsTrigger>
                  {editor.mode === "json" ? (
                    <TabsTrigger value="json" disabled={disabled}>
                      {t("editor.json")}
                    </TabsTrigger>
                  ) : null}
                </TabsList>
                <Popover open={advancedOpen} onOpenChange={setAdvancedOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="sm" disabled={disabled}>
                      <Settings2 className="size-4" />
                      {t("editor.advanced")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    aria-label={t("editor.settings")}
                    className="max-h-[min(32rem,70dvh)] w-[min(26rem,calc(100vw-2rem))] space-y-4 overflow-y-auto"
                  >
                    <h3 className="text-sm font-medium">
                      {t("editor.settings")}
                    </h3>
                    <div className="space-y-2">
                      <Label htmlFor={`${id}-name`}>
                        {t("dialogs.create.nameLabel")}
                      </Label>
                      <Input
                        id={`${id}-name`}
                        value={editor.name}
                        onChange={event => editor.setName(event.target.value)}
                        maxLength={WHATSAPP_FLOW_LIMITS.NAME_MAX_LENGTH}
                        disabled={disabled || editor.readOnly}
                      />
                    </div>
                    <fieldset
                      disabled={disabled || editor.readOnly}
                      className="space-y-2"
                    >
                      <legend className="mb-2 text-sm font-medium">
                        {t("dialogs.create.categoriesLabel")}
                      </legend>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        {WHATSAPP_FLOW_CATEGORIES.map(category => (
                          <label
                            key={category}
                            className="flex min-h-8 min-w-0 items-start gap-2 text-xs"
                          >
                            <Checkbox
                              className="mt-0.5 shrink-0"
                              checked={editor.categories.includes(category)}
                              onCheckedChange={checked =>
                                editor.setCategories(current =>
                                  checked
                                    ? [...current, category]
                                    : current.filter(item => item !== category)
                                )
                              }
                            />
                            <span className="break-words">
                              {t(`categories.${category}`)}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                          editor.setMode("json");
                          setAdvancedOpen(false);
                        }}
                      >
                        {t("editor.json")}
                      </Button>
                      {!editor.readOnly ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled}
                          onClick={() => upload.current?.click()}
                        >
                          <Upload className="size-4" />
                          {t("editor.import")}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!editor.source || disabled}
                        onClick={editor.exportFile}
                      >
                        <Download className="size-4" />
                        {t("editor.export")}
                      </Button>
                    </div>
                    {previewUrl ? (
                      <div className="space-y-2">
                        <Button asChild variant="ghost" size="sm">
                          <a
                            href={previewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t("actions.preview")}
                          >
                            <ExternalLink className="size-4" />
                            {t("actions.preview")}
                          </a>
                        </Button>
                        {editor.dirty ? (
                          <p className="text-xs text-muted-foreground">
                            {t("editor.savedBeforePreview")}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </PopoverContent>
                </Popover>
                <input
                  ref={upload}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  aria-label={t("editor.import")}
                  onChange={event => {
                    const file = event.target.files?.[0];
                    if (file) void editor.importFile(file);
                    event.target.value = "";
                  }}
                />
              </div>
              <div className="max-h-[25dvh] shrink-0 space-y-2 overflow-y-auto px-4 sm:px-5">
                {editor.readOnly ? (
                  <Alert>
                    <AlertDescription>
                      {t(
                        editor.details.managedArtifact ||
                          props.flow.managedArtifact
                          ? "editor.managedReadOnly"
                          : "editor.readOnly"
                      )}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {editor.error || editor.assetError ? (
                  <Alert variant="destructive">
                    <AlertCircle className="size-4" />
                    <AlertDescription>
                      {editor.error || editor.assetError}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {editor.issues.length ? (
                  <Alert variant="destructive">
                    <AlertDescription>
                      <p className="font-medium">
                        {t("editor.validationTitle")}
                      </p>
                      <ul className="mt-2 space-y-1 text-xs">
                        {editor.issues.map((issue, index) => (
                          <li key={index} className="break-words">
                            {issue}
                          </li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </div>
              <div
                data-testid="flow-editor-body"
                className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
              >
                {!editor.source && !editor.readOnly ? (
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <h3 className="text-sm font-medium">
                      {t("editor.emptyTitle")}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("editor.emptyDescription")}
                    </p>
                    <TemplatePicker onSelect={editor.selectTemplate} />
                  </div>
                ) : (
                  <>
                    <TabsContent
                      forceMount
                      hidden={editor.mode !== "visual"}
                      value="visual"
                      className="m-0 min-h-0 min-w-0 flex-1 data-[state=active]:flex data-[state=inactive]:hidden"
                    >
                      <fieldset
                        disabled={disabled || editor.readOnly}
                        className="flex min-h-0 min-w-0 flex-1 flex-col"
                      >
                        {editor.visualConfig ? (
                          <FlowFormEditorContent
                            authoringContext="manager"
                            fillAvailableHeight
                            fieldKeyLabel={t("editor.fieldKey")}
                            flowConfig={editor.visualConfig}
                            onChange={editor.changeConfig}
                            renderPreview={screenId => renderPreview(screenId)}
                            className="min-h-0 min-w-0 flex-1"
                          />
                        ) : null}
                      </fieldset>
                    </TabsContent>
                    <TabsContent
                      forceMount
                      hidden={editor.mode !== "json"}
                      value="json"
                      className="m-0 min-h-0 min-w-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
                    >
                      <div className="flex shrink-0 gap-1 px-4 pb-2 lg:hidden">
                        <Button
                          variant={jsonPreviewOpen ? "ghost" : "secondary"}
                          size="sm"
                          aria-pressed={!jsonPreviewOpen}
                          onClick={() => setJsonPreviewOpen(false)}
                        >
                          {t("editor.json")}
                        </Button>
                        <Button
                          variant={jsonPreviewOpen ? "secondary" : "ghost"}
                          size="sm"
                          aria-pressed={jsonPreviewOpen}
                          onClick={() => setJsonPreviewOpen(true)}
                        >
                          {t("editor.preview")}
                        </Button>
                      </div>
                      <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[minmax(0,1fr)_360px]">
                        <div
                          className={`${jsonPreviewOpen ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4 sm:px-5`}
                        >
                          {!editor.canEditVisually && editor.source ? (
                            <p className="shrink-0 text-xs leading-relaxed text-muted-foreground">
                              {t(
                                editor.visualConfig?.flowNavigationMode ===
                                  "data_endpoint"
                                  ? "editor.endpointJsonOnly"
                                  : "editor.visualUnavailable"
                              )}
                            </p>
                          ) : null}
                          <div className="flex shrink-0 items-center justify-between gap-2">
                            <Label htmlFor={`${id}-json`}>
                              {t("editor.sourceLabel")}
                            </Label>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={
                                !editor.parsed || editor.readOnly || disabled
                              }
                              onClick={() =>
                                editor.setSource(
                                  JSON.stringify(editor.parsed, null, 2)
                                )
                              }
                            >
                              {t("editor.format")}
                            </Button>
                          </div>
                          <Textarea
                            id={`${id}-json`}
                            aria-label={t("editor.sourceLabel")}
                            value={editor.source}
                            onChange={event =>
                              editor.setSource(event.target.value)
                            }
                            readOnly={editor.readOnly}
                            disabled={disabled}
                            spellCheck={false}
                            className="min-h-40 flex-1 resize-none whitespace-pre font-mono text-xs leading-6"
                          />
                        </div>
                        <aside
                          className={`${jsonPreviewOpen ? "block" : "hidden lg:block"} min-h-0 min-w-0 space-y-3 overflow-y-auto bg-muted/15 p-4 sm:px-5`}
                        >
                          <h3 className="text-sm font-medium">
                            {t("editor.preview")}
                          </h3>
                          {renderPreview()}
                        </aside>
                      </div>
                    </TabsContent>
                  </>
                )}
              </div>
            </Tabs>
            <div
              data-testid="flow-editor-actions"
              className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3 sm:px-5"
            >
              {publishBlockedReason ? (
                <p
                  id={`${id}-publish-reason`}
                  role="status"
                  className="w-full text-xs text-muted-foreground sm:mr-auto sm:w-auto sm:max-w-sm"
                >
                  {publishBlockedReason}
                </p>
              ) : null}
              {!editor.readOnly ? (
                <>
                  <Button
                    variant="outline"
                    disabled={disabled || !editor.source || !editor.dirty}
                    onClick={() => void editor.mutate("save")}
                  >
                    {editor.busy === "save" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Save className="size-4" />
                    )}
                    {t(
                      editor.busy === "save" ? "editor.saving" : "editor.save"
                    )}
                  </Button>
                  <Button
                    disabled={disabled || !editor.canPublish}
                    aria-describedby={
                      publishBlockedReason ? `${id}-publish-reason` : undefined
                    }
                    onClick={() => void editor.mutate("publish")}
                  >
                    {editor.busy === "publish" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    {t(
                      editor.busy === "publish"
                        ? "editor.publishing"
                        : "editor.publish"
                    )}
                  </Button>
                </>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
