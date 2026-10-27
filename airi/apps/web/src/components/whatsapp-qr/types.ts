import type {
  WhatsAppQrEntryPointDetail,
  WhatsAppQrProviderCodeOption,
} from "@/lib/whatsapp/qr-entry-points/client";

export type WhatsAppQrSourceOption = {
  id: string;
  label: string;
};

export type WhatsAppQrPendingOperationKey =
  | "save-draft"
  | "save-settings"
  | "create-code"
  | "connect-provider-code"
  | "connect-from-url"
  | "connect-from-image"
  | "apply-message"
  | "create-replacement"
  | "recover-detached"
  | "check-provider"
  | `set-routing:${string}:${"ENABLED" | "DISABLED"}`
  | `delete:${string}`
  | `reconcile:${string}`
  | `download:${"png" | "svg"}`;

export type WhatsAppQrMutationOptions = {
  operationKey?: WhatsAppQrPendingOperationKey;
};

export type WhatsAppQrDraftCreatorInput = {
  workspaceId: string;
  entryPointId: string;
  placementName: string;
  desiredMessage?: string;
  signal?: AbortSignal;
};

/**
 * Optional compatibility boundary for hosts that must coordinate another
 * durable owner while creating a draft. The Scenario Builder uses its Task 5
 * graph/projection transaction here; Manager callers omit this adapter.
 */
export type WhatsAppQrDraftCreator = (
  input: WhatsAppQrDraftCreatorInput
) => Promise<WhatsAppQrEntryPointDetail>;

export type UseWhatsAppQrEntryPointParams = {
  workspaceId: string;
  entryPointId: string | null;
  /** Narrows ownership for embedded hosts whose null draft can move surfaces. */
  ownerKey?: string;
  draftCreator?: WhatsAppQrDraftCreator;
  onEntryPointCreated?: (entryPointId: string) => void;
  onMutationSettled?: () => void | Promise<void>;
};

export type WhatsAppQrEntryPointController = {
  detail: WhatsAppQrEntryPointDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  detailErrorStatus?: number | null;
  commandBusy: boolean;
  pendingOperationKey: WhatsAppQrPendingOperationKey | null;
  commandError: string | null;
  statusMessage: string | null;
  providerCodes: WhatsAppQrProviderCodeOption[];
  providerCodesLoading: boolean;
  providerCodesError: string | null;
  providerCodesCanGoPrevious: boolean;
  providerCodesCanGoNext: boolean;
  retryDetail(): void;
  loadProviderCodes(sourceId: string): Promise<void>;
  goToPreviousProviderCodesPage(): Promise<void>;
  goToNextProviderCodesPage(): Promise<void>;
  saveDraft(
    input: {
      placementName: string;
      desiredMessage?: string | null;
    },
    options?: WhatsAppQrMutationOptions
  ): Promise<boolean>;
  createCode(input: {
    sourceId: string;
    placementName: string;
    desiredMessage: string;
  }): Promise<boolean>;
  connectProviderCode(input: {
    sourceId: string;
    providerCode: string;
    placementName: string;
    desiredMessage: string;
  }): Promise<boolean>;
  connectFromUrl(input: {
    sourceId: string;
    url: string;
    placementName: string;
    desiredMessage: string;
  }): Promise<boolean>;
  connectFromImage(input: {
    sourceId: string;
    file: File;
    placementName: string;
    desiredMessage: string;
  }): Promise<boolean>;
  applyMessage(
    desiredMessage: string,
    options?: WhatsAppQrMutationOptions
  ): Promise<boolean>;
  createReplacement(desiredMessage: string): Promise<boolean>;
  setRouting(codeId: string, state: "ENABLED" | "DISABLED"): Promise<boolean>;
  deleteFromMeta(codeId: string): Promise<boolean>;
  recoverDetached(): Promise<boolean>;
  checkProvider(): Promise<boolean>;
  reconcileOperation(operationId: string): Promise<boolean>;
  downloadArtwork(format: "png" | "svg"): Promise<boolean>;
  copyLink(): Promise<boolean>;
  testLink(): void;
};
