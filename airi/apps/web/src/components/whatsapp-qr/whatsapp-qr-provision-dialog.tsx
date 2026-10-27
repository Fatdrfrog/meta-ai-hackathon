"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageIcon,
  LinkIcon,
  ListIcon,
  PlusIcon,
  SaveIcon,
  UploadIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";

import { useLatestRef } from "@/components/scenarios/view/use-latest-ref";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTransitionOwnerKey } from "@/hooks/use-transition-owner-key";
import { newWhatsAppQrIdempotencyKey } from "@/lib/whatsapp/qr-entry-points/client";

import type { WhatsAppQrSourceOption } from "./types";
import { useWhatsAppQrEntryPoint } from "./use-whatsapp-qr-entry-point";
import {
  useWhatsAppQrEntryPointValidationMessages,
  validateWhatsAppQrEntryPointForm,
  WhatsAppQrEntryPointForm,
  type WhatsAppQrEntryPointFormValue,
} from "./whatsapp-qr-entry-point-form";

export type WhatsAppQrProvisionIntent = "create" | "import";
export type WhatsAppQrImportMethod = "provider" | "link" | "image";

export type WhatsAppQrProvisionDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialIntent: WhatsAppQrProvisionIntent;
  workspaceId: string;
  sourceOptions: readonly WhatsAppQrSourceOption[];
  onCompleted(entryPointId: string): void;
};

export function WhatsAppQrProvisionDialog(
  props: WhatsAppQrProvisionDialogProps
) {
  const sessionTransitionKey = useTransitionOwnerKey(
    props.open ? "open" : "closed"
  );

  return (
    <WhatsAppQrProvisionDialogSession key={sessionTransitionKey} {...props} />
  );
}

function WhatsAppQrProvisionDialogSession({
  open,
  onOpenChange,
  initialIntent,
  workspaceId,
  sourceOptions,
  onCompleted,
}: WhatsAppQrProvisionDialogProps) {
  const t = useTranslations("WhatsAppQr");
  const validationMessages = useWhatsAppQrEntryPointValidationMessages();
  const [sessionId] = useState(newWhatsAppQrIdempotencyKey);
  const intent = initialIntent;
  const [importMethod, setImportMethod] =
    useState<WhatsAppQrImportMethod>("provider");
  const [formValue, setFormValue] = useState<WhatsAppQrEntryPointFormValue>(
    () => ({
      sourceId: sourceOptions[0]?.id || "",
      placementName: "",
      desiredMessage: "",
    })
  );
  const [showErrors, setShowErrors] = useState(false);
  const [requireProviderFields, setRequireProviderFields] = useState(false);
  const [providerCode, setProviderCode] = useState("");
  const [providerPageSourceId, setProviderPageSourceId] = useState<
    string | null
  >(null);
  const [providerPageAction, setProviderPageAction] = useState<
    "load" | "previous" | "next" | null
  >(null);
  const [linkValue, setLinkValue] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const [draftEntryPointId, setDraftEntryPointId] = useState<string | null>(
    null
  );
  const draftEntryPointIdRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const interactionBusyRef = useRef(false);
  const openRef = useLatestRef(open);
  const formIdPrefix = `whatsapp-qr-provision-${sessionId}`;

  const controller = useWhatsAppQrEntryPoint({
    workspaceId,
    entryPointId: null,
    ownerKey: sessionId,
    onEntryPointCreated: entryPointId => {
      draftEntryPointIdRef.current = entryPointId;
      setDraftEntryPointId(entryPointId);
    },
  });
  const selectedProviderCodeLabel = (() => {
    const selected = controller.providerCodes.find(
      code => code.code === providerCode
    );
    return selected
      ? selected.prefilledMessage || selected.deepLink || selected.code
      : providerCode || undefined;
  })();
  const primaryOperationKey =
    intent === "create"
      ? "create-code"
      : importMethod === "provider"
        ? "connect-provider-code"
        : importMethod === "link"
          ? "connect-from-url"
          : "connect-from-image";

  const validate = (requireSource: boolean, requireMessage: boolean) => {
    setShowErrors(true);
    setRequireProviderFields(requireSource || requireMessage);
    setMethodError(null);
    return (
      Object.keys(
        validateWhatsAppQrEntryPointForm(formValue, {
          requireSource,
          requireMessage,
          messages: validationMessages,
        })
      ).length === 0
    );
  };

  const complete = (succeeded: boolean) => {
    if (!succeeded || !openRef.current) return;
    const entryPointId =
      draftEntryPointIdRef.current ||
      controller.detail?.entryPoint.entryPointId ||
      null;
    if (entryPointId) onCompleted(entryPointId);
  };

  const saveDraft = async () => {
    if (!validate(false, false)) return;
    interactionBusyRef.current = true;
    try {
      complete(
        await controller.saveDraft({
          placementName: formValue.placementName.trim(),
          ...(formValue.desiredMessage.trim()
            ? { desiredMessage: formValue.desiredMessage.trim() }
            : {}),
        })
      );
    } finally {
      interactionBusyRef.current = false;
    }
  };

  const submitProviderOperation = async () => {
    if (!validate(true, true)) return;
    const common = {
      sourceId: formValue.sourceId,
      placementName: formValue.placementName.trim(),
      desiredMessage: formValue.desiredMessage.trim(),
    };

    if (intent === "create") {
      interactionBusyRef.current = true;
      try {
        complete(await controller.createCode(common));
      } finally {
        interactionBusyRef.current = false;
      }
      return;
    }

    if (importMethod === "provider") {
      if (
        !providerCode ||
        providerPageSourceId !== formValue.sourceId ||
        controller.providerCodesLoading ||
        !controller.providerCodes.some(code => code.code === providerCode)
      ) {
        setMethodError(t("dialog.errors.chooseProviderCode"));
        return;
      }
      interactionBusyRef.current = true;
      try {
        complete(
          await controller.connectProviderCode({
            ...common,
            providerCode,
          })
        );
      } finally {
        interactionBusyRef.current = false;
      }
      return;
    }

    if (importMethod === "link") {
      if (!linkValue.trim()) {
        setMethodError(t("dialog.errors.enterLink"));
        return;
      }
      interactionBusyRef.current = true;
      try {
        complete(
          await controller.connectFromUrl({
            ...common,
            url: linkValue.trim(),
          })
        );
      } finally {
        interactionBusyRef.current = false;
      }
      return;
    }

    if (!imageFile) {
      setMethodError(t("dialog.errors.chooseImage"));
      return;
    }
    interactionBusyRef.current = true;
    try {
      complete(
        await controller.connectFromImage({
          ...common,
          file: imageFile,
        })
      );
    } finally {
      interactionBusyRef.current = false;
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitProviderOperation();
  };

  const loadProviderCodes = async () => {
    setProviderCode("");
    setProviderPageSourceId(formValue.sourceId);
    setProviderPageAction("load");
    try {
      await controller.loadProviderCodes(formValue.sourceId);
    } finally {
      setProviderPageAction(null);
    }
  };

  const goToProviderCodesPage = async (direction: "previous" | "next") => {
    setProviderCode("");
    setProviderPageAction(direction);
    try {
      if (direction === "previous") {
        await controller.goToPreviousProviderCodesPage();
      } else {
        await controller.goToNextProviderCodesPage();
      }
    } finally {
      setProviderPageAction(null);
    }
  };

  const draftHref = draftEntryPointId
    ? `/panel/w/${workspaceId}/messengers/whatsapp-qr/${encodeURIComponent(draftEntryPointId)}`
    : null;
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (interactionBusyRef.current || controller.commandBusy)) {
      return;
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[min(90dvh,52rem)] w-full flex-col overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={event => {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          event.preventDefault();
          requestAnimationFrame(() => {
            document.getElementById(`${formIdPrefix}-placement`)?.focus();
          });
        }}
        onCloseAutoFocus={event => {
          if (!returnFocusRef.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
        onEscapeKeyDown={event => {
          if (interactionBusyRef.current || controller.commandBusy) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={event => {
          if (interactionBusyRef.current || controller.commandBusy) {
            event.preventDefault();
          }
        }}
        onInteractOutside={event => {
          if (interactionBusyRef.current || controller.commandBusy) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="px-6 pt-6 pr-12">
          <DialogTitle>
            {intent === "create"
              ? t("dialog.createTitle")
              : t("dialog.importTitle")}
          </DialogTitle>
          <DialogDescription>
            {intent === "create"
              ? t("dialog.createIntentDescription")
              : t("dialog.importIntentDescription")}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onSubmit={onSubmit}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
            <FieldGroup>
              <WhatsAppQrEntryPointForm
                value={formValue}
                onChange={next => {
                  if (next.sourceId !== formValue.sourceId) {
                    setProviderCode("");
                    setProviderPageSourceId(null);
                    setMethodError(null);
                  }
                  setFormValue(next);
                }}
                sourceOptions={sourceOptions}
                disabled={controller.commandBusy}
                requireSource={requireProviderFields}
                requireMessage={requireProviderFields}
                showErrors={showErrors}
                idPrefix={formIdPrefix}
              />

              {intent === "import" ? (
                <FieldSet className="gap-4">
                  <FieldLegend
                    id={`${formIdPrefix}-import-method-label`}
                    variant="label"
                    className="mb-0"
                  >
                    {t("dialog.importMethodLabel")}
                  </FieldLegend>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={importMethod}
                    disabled={controller.commandBusy}
                    onValueChange={value => {
                      if (!value) return;
                      setImportMethod(value as WhatsAppQrImportMethod);
                      setMethodError(null);
                    }}
                    aria-labelledby={`${formIdPrefix}-import-method-label`}
                    className="w-full flex-col items-stretch gap-2 shadow-none sm:flex-row sm:items-center sm:gap-0 sm:shadow-xs"
                  >
                    <ToggleGroupItem
                      value="provider"
                      className="w-full justify-start rounded-md border whitespace-normal data-[variant=outline]:border-l sm:justify-center sm:rounded-none sm:first:rounded-l-md sm:last:rounded-r-md sm:whitespace-nowrap"
                    >
                      <ListIcon aria-hidden className="hidden sm:block" />
                      {t("dialog.methodProvider")}
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="link"
                      className="w-full justify-start rounded-md border whitespace-normal data-[variant=outline]:border-l sm:justify-center sm:rounded-none sm:first:rounded-l-md sm:last:rounded-r-md sm:whitespace-nowrap"
                    >
                      <LinkIcon aria-hidden className="hidden sm:block" />
                      {t("dialog.methodLink")}
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value="image"
                      className="w-full justify-start rounded-md border whitespace-normal data-[variant=outline]:border-l sm:justify-center sm:rounded-none sm:first:rounded-l-md sm:last:rounded-r-md sm:whitespace-nowrap"
                    >
                      <ImageIcon aria-hidden className="hidden sm:block" />
                      {t("dialog.methodImage")}
                    </ToggleGroupItem>
                  </ToggleGroup>

                  {importMethod === "provider" ? (
                    <Field
                      data-invalid={Boolean(methodError) || undefined}
                      className="gap-4 rounded-lg border p-4"
                    >
                      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex min-w-0 flex-col gap-1">
                          <FieldLabel htmlFor={`${formIdPrefix}-provider-code`}>
                            {t("dialog.providerCodeLabel")}
                          </FieldLabel>
                          <FieldDescription>
                            {t("dialog.providerCodeDescription")}
                          </FieldDescription>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={
                            controller.commandBusy ||
                            (controller.providerCodesLoading &&
                              providerPageSourceId === formValue.sourceId) ||
                            !formValue.sourceId
                          }
                          onClick={() => void loadProviderCodes()}
                        >
                          {controller.providerCodesLoading &&
                          providerPageAction === "load" ? (
                            <span data-icon="inline-start">
                              <Spinner />
                            </span>
                          ) : (
                            <ListIcon data-icon="inline-start" />
                          )}
                          {t("dialog.loadProviderCodes")}
                        </Button>
                      </div>

                      <Select
                        value={providerCode}
                        onValueChange={value => {
                          setProviderCode(value);
                          setMethodError(null);
                        }}
                        disabled={
                          controller.commandBusy ||
                          controller.providerCodesLoading ||
                          providerPageSourceId !== formValue.sourceId ||
                          controller.providerCodes.length === 0
                        }
                      >
                        <SelectTrigger
                          id={`${formIdPrefix}-provider-code`}
                          className="w-full min-w-0 max-w-full *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate"
                          aria-label={
                            selectedProviderCodeLabel
                              ? `${t("dialog.providerCodeLabel")}: ${selectedProviderCodeLabel}`
                              : t("dialog.providerCodePlaceholder")
                          }
                          title={selectedProviderCodeLabel}
                          aria-invalid={Boolean(methodError) || undefined}
                        >
                          <SelectValue
                            placeholder={t("dialog.providerCodePlaceholder")}
                          />
                        </SelectTrigger>
                        <SelectContent className="w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] sm:max-w-[32rem]">
                          <SelectGroup>
                            {controller.providerCodes.map(code => {
                              const label =
                                code.prefilledMessage ||
                                code.deepLink ||
                                code.code;
                              return (
                                <SelectItem
                                  key={code.code}
                                  value={code.code}
                                  textValue={label}
                                  aria-label={label}
                                  title={label}
                                  className="max-w-[calc(100vw-3rem)] overflow-hidden sm:max-w-[31rem]"
                                >
                                  <span className="block min-w-0 max-w-full truncate">
                                    {label}
                                  </span>
                                </SelectItem>
                              );
                            })}
                          </SelectGroup>
                        </SelectContent>
                      </Select>

                      <FieldError>{methodError}</FieldError>
                      {controller.providerCodesError ? (
                        <FieldError>{controller.providerCodesError}</FieldError>
                      ) : null}
                      {controller.providerCodesCanGoPrevious ||
                      controller.providerCodesCanGoNext ? (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={
                              controller.providerCodesLoading ||
                              !controller.providerCodesCanGoPrevious
                            }
                            onClick={() =>
                              void goToProviderCodesPage("previous")
                            }
                          >
                            {controller.providerCodesLoading &&
                            providerPageAction === "previous" ? (
                              <span data-icon="inline-start">
                                <Spinner />
                              </span>
                            ) : (
                              <ChevronLeftIcon data-icon="inline-start" />
                            )}
                            {t("actions.previous")}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={
                              controller.providerCodesLoading ||
                              !controller.providerCodesCanGoNext
                            }
                            onClick={() => void goToProviderCodesPage("next")}
                          >
                            {t("actions.next")}
                            {controller.providerCodesLoading &&
                            providerPageAction === "next" ? (
                              <span data-icon="inline-end">
                                <Spinner />
                              </span>
                            ) : (
                              <ChevronRightIcon data-icon="inline-end" />
                            )}
                          </Button>
                        </div>
                      ) : null}
                    </Field>
                  ) : null}

                  {importMethod === "link" ? (
                    <Field data-invalid={Boolean(methodError) || undefined}>
                      <FieldLabel htmlFor={`${formIdPrefix}-link`}>
                        {t("dialog.linkLabel")}
                      </FieldLabel>
                      <Input
                        id={`${formIdPrefix}-link`}
                        type="url"
                        value={linkValue}
                        onChange={event => {
                          setLinkValue(event.target.value);
                          setMethodError(null);
                        }}
                        placeholder="https://wa.me/message/..."
                        disabled={controller.commandBusy}
                        aria-invalid={Boolean(methodError) || undefined}
                      />
                      <FieldDescription>
                        {t("dialog.linkDescription")}
                      </FieldDescription>
                      <FieldError>{methodError}</FieldError>
                    </Field>
                  ) : null}

                  {importMethod === "image" ? (
                    <Field data-invalid={Boolean(methodError) || undefined}>
                      <FieldLabel htmlFor={`${formIdPrefix}-image`}>
                        {t("dialog.imageLabel")}
                      </FieldLabel>
                      <Input
                        ref={imageInputRef}
                        id={`${formIdPrefix}-image`}
                        type="file"
                        className="sr-only"
                        accept="image/png,image/jpeg,image/webp"
                        disabled={controller.commandBusy}
                        aria-invalid={Boolean(methodError) || undefined}
                        onChange={event => {
                          setImageFile(event.target.files?.[0] || null);
                          setMethodError(null);
                        }}
                      />
                      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-5 text-center">
                        <ImageIcon
                          aria-hidden
                          className="size-6 text-muted-foreground"
                        />
                        <span
                          aria-live="polite"
                          className="max-w-full truncate text-sm font-medium"
                          title={imageFile?.name}
                        >
                          {imageFile?.name || t("dialog.imageLabel")}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={controller.commandBusy}
                          onClick={() => imageInputRef.current?.click()}
                        >
                          <UploadIcon data-icon="inline-start" />
                          {t("dialog.chooseImageAction")}
                        </Button>
                      </div>
                      <FieldDescription>
                        {t("dialog.imageDescription")}
                      </FieldDescription>
                      <FieldError>{methodError}</FieldError>
                    </Field>
                  ) : null}
                </FieldSet>
              ) : null}

              {controller.commandError ? (
                <Alert variant="destructive">
                  <AlertTitle>{t("dialog.operationFailedTitle")}</AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-3">
                    <span>{controller.commandError}</span>
                    {draftHref ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={draftHref}>{t("dialog.openDraft")}</Link>
                      </Button>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </div>

          <DialogFooter className="shrink-0 border-t px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              disabled={controller.commandBusy}
              onClick={() => handleOpenChange(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={controller.commandBusy}
              onClick={() => void saveDraft()}
            >
              {controller.pendingOperationKey === "save-draft" ? (
                <span data-icon="inline-start">
                  <Spinner />
                </span>
              ) : (
                <SaveIcon data-icon="inline-start" />
              )}
              {t("actions.saveDraft")}
            </Button>
            <Button type="submit" disabled={controller.commandBusy}>
              {controller.pendingOperationKey === primaryOperationKey ? (
                <span data-icon="inline-start">
                  <Spinner />
                </span>
              ) : intent === "create" ? (
                <PlusIcon data-icon="inline-start" />
              ) : (
                <UploadIcon data-icon="inline-start" />
              )}
              {intent === "create" ? t("actions.create") : t("actions.import")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
