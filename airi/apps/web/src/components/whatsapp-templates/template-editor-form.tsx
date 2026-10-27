"use client";

import { reloadToLatestAppVersion } from "@/lib/app-version-reload";
import type { CreativeAsset } from "@/components/assets/creative-assets-workspace";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  createUnifiedTemplateAction,
  updateTemplateAction,
  updateUnifiedTemplateAction,
} from "@/features/panel/messengers/whatsapp-templates/actions";
import { createClient as createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  fetchWhatsAppFlowsList,
  getWhatsAppFlowStatusVariant,
} from "@/lib/whatsapp/flows/client";
import { extractWhatsAppFlowScreenIds } from "@/lib/whatsapp/flows/screen-ids";
import {
  evaluateTemplateFlowHealth,
  type TemplateFlowHealth,
} from "@/lib/whatsapp/flows/template-flow-health";
import { TemplateFlowHealthNotice } from "./template-flow-health-notice";
import {
  getWhatsAppTemplateHeaderMediaValidationIssue,
  type WhatsAppTemplateHeaderMediaValidationIssue,
} from "@/lib/whatsapp/templates/header-media-constraints";
import { readWhatsAppTemplateNamedParamExamples } from "@/lib/whatsapp/templates/parameter-format";
import { WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_BY_FORMAT } from "@/lib/whatsapp/media-types";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  TEMPLATE_CATEGORY_METADATA,
  WHATSAPP_TEMPLATE_LIMITS,
  canEditTemplate,
  normalizeWhatsAppTemplateLanguageCode,
} from "@icecore/shared/constants/whatsapp-templates";
import type {
  TelegramTemplateData,
  TemplateChannel,
} from "@icecore/shared/types/templates";
import type { WhatsAppTemplate } from "@icecore/shared/types/whatsapp";
import {
  extractTemplateVariables,
  isValidTemplateName,
} from "@icecore/shared/types/whatsapp";
import {
  Bold,
  Code,
  Images,
  Italic,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  Strikethrough,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import Image from "next/image";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { useForm, useFieldArray, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import TelegramIcon from "../integrations/assets/telegram.svg";
import WhatsAppIcon from "../integrations/assets/whatsapp.svg";
import {
  buildWhatsAppMarketingMessagesOptimizationSpecFromFormValues,
  buildWhatsAppTemplateComponentsFromFormValues,
  getFirstTemplateFormErrorMessage,
  getTemplateFormVariableFormatIssues,
  getWhatsAppTemplateCarouselComponent,
  getWhatsAppTemplateHeaderMediaExample,
  hasTemplateHeaderFormattingMarkers,
  isTemplateFormTextHeaderActive,
  isWhatsAppTemplateMediaHeaderFormat,
  normalizeTemplateNameInput,
  type TemplateFormValues,
} from "./template-editor-form-utils";
import {
  clearTemplateEditorDraft,
  getTemplateEditorDraftKey,
  hasTemplateEditorDraftContent,
  readRestorableTemplateEditorDraft,
  snapshotTemplateEditorValues,
  writeTemplateEditorDraft,
} from "./template-editor-draft";
import { TemplateCarouselFields } from "./template-carousel-fields";
import {
  createTemplateCarouselDraftCards,
  parseTemplateCarouselCardsFromComponent,
  type TemplateCarouselCardFormValue,
} from "./template-carousel-model";
import {
  carouselCardsHaveUserContent,
  getWhatsAppMarketingLayout,
  standardLayoutHasExclusiveSections,
} from "./template-whatsapp-layout";
import { TemplateWhatsAppLayoutPicker } from "./template-whatsapp-layout-picker";
import {
  createTemplateButtonTypeLimitSchema,
  createTemplateButtonsSchema,
  createWhatsAppFlowCreateResponseSchema,
  createWhatsAppFlowNameSchema,
  getFirstZodIssueMessage,
  type TemplateButtonValidationMessages,
} from "./template-flow-button-validation";
import {
  TEMPLATE_FORM_FIELD_ITEM_CLASS,
  TEMPLATE_FORM_OPTIONAL_ACTION_CLASS,
  TEMPLATE_FORM_SELECT_TRIGGER_CLASS,
  TemplateFormSection,
} from "./template-editor-form-layout";
import { TemplateLanguageSelect } from "./template-language-select";
import { TemplatePhonePreview } from "./template-phone-preview";
import {
  collectTemplateVariableKeys,
  hasValidTemplateUrlVariablePlacement,
  isValidVariableName,
  renameTemplateVariableInText,
} from "./template-variable-utils";

const CreativeAssetPickerDialog = dynamic(
  () =>
    import("@/components/assets/creative-asset-picker-dialog").then(
      mod => mod.CreativeAssetPickerDialog
    ),
  { ssr: false }
);

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Meta doesn't allow variables at the start or end of text
 */
function hasVariableAtStartOrEnd(text: string): {
  valid: boolean;
  errorKey?: string;
} {
  const trimmed = text.trim();

  // Check if text starts with a variable like {{1}}
  if (/^\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(trimmed)) {
    return {
      valid: false,
      errorKey: "form.variablePlacementError",
    };
  }

  // Check if text ends with a variable like {{1}}
  if (/\{\{\s*[A-Za-z0-9_]+\s*\}\}$/.test(trimmed)) {
    return {
      valid: false,
      errorKey: "form.variablePlacementError",
    };
  }

  return { valid: true };
}

/**
 * Validate variable numbering (must be consecutive starting from 1)
 */
function hasValidVariableNumbering(text: string): {
  valid: boolean;
  errorKey?: string;
  vars?: string[];
} {
  const vars = extractTemplateVariables(text);
  if (vars.length === 0) return { valid: true };

  // Named variables are valid and do not use positional numbering checks.
  if (vars.some(v => !/^\d+$/.test(v))) {
    return { valid: true };
  }

  // Check if variables are consecutive starting from 1
  for (let i = 0; i < vars.length; i++) {
    if (parseInt(vars[i]) !== i + 1) {
      return {
        valid: false,
        errorKey: "form.variableNumberingError",
        vars,
      };
    }
  }

  return { valid: true };
}

function getNextVariableIndex(text: string): number {
  const vars = extractTemplateVariables(text)
    .map(v => parseInt(v, 10))
    .filter(n => !Number.isNaN(n) && n > 0)
    .sort((a, b) => a - b);
  let next = 1;
  for (const v of vars) {
    if (v === next) next += 1;
  }
  return next;
}

export interface EditableTemplate {
  metaId?: string;
  dbId?: string;
  channel?: TemplateChannel;
  telegramData?: TelegramTemplateData;
}

interface TemplateEditorFormProps {
  template?: WhatsAppTemplate & EditableTemplate;
  workspaceId: string;
  onSuccess: () => void;
  onCancel?: () => void;
  className?: string;
  title?: string;
  layout?: "default" | "modal";
  platformScope?: "all" | "whatsapp";
  /** Query parameters that reopen this editor when the page reloads. */
  reopenSearchParams?: Record<string, string>;
}

/** Typing pauses this long before the draft is written to the browser. */
const TEMPLATE_EDITOR_DRAFT_SAVE_DELAY_MS = 500;

type WhatsAppFlowOption = {
  id: string;
  name?: string;
  status?: string;
};

const EDITOR_FLOW_FACTS_CHECKED_AT = new Date(0).toISOString();

/**
 * The template Flow check for one FLOW button, from what the editor already
 * loaded: the Flow list's status and the screens read from the Flow JSON.
 */
function evaluateEditorFlowButton(params: {
  text?: string;
  flowId: string;
  flowAction?: string;
  navigateScreen?: string;
  flow?: WhatsAppFlowOption;
  screenIds: string[];
}): TemplateFlowHealth | null {
  if (!params.flow?.status && params.screenIds.length === 0) return null;
  return evaluateTemplateFlowHealth(
    [
      {
        type: "BUTTONS",
        buttons: [
          {
            type: "FLOW",
            text: params.text ?? "",
            flow_id: params.flowId,
            flow_action: params.flowAction,
            navigate_screen: params.navigateScreen,
          },
        ],
      },
    ],
    {
      [params.flowId]: {
        flowId: params.flowId,
        state: "found",
        name: params.flow?.name ?? null,
        // Until the Flow list loads the status is unknown; screens still count.
        status: params.flow?.status ?? "PUBLISHED",
        screenIds: params.screenIds.length > 0 ? params.screenIds : null,
        checkedAt: EDITOR_FLOW_FACTS_CHECKED_AT,
      },
    }
  );
}

type WhatsAppFlowDetailsResponse = {
  flowJson?: unknown;
  flowJsonError?: string | null;
  error?: string;
};

type HeaderMediaUploadResponse = {
  upload?: {
    bucket?: unknown;
    path?: unknown;
    token?: unknown;
  };
  media?: {
    url?: unknown;
    fileName?: unknown;
    fileSize?: unknown;
    mimeType?: unknown;
  };
  error?: string;
};

type HeaderMediaUploadReadResult = {
  payload: HeaderMediaUploadResponse | null;
  rawText: string;
};

type UploadedHeaderMedia = {
  url: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
};

type WhatsAppTemplateButtonFormValue = NonNullable<
  TemplateFormValues["buttons"]
>[number];
type WhatsAppTemplateButtonFormType = WhatsAppTemplateButtonFormValue["type"];

let templateButtonClientIdCounter = 0;

function createTemplateButtonClientId(prefix: "whatsapp" | "telegram") {
  templateButtonClientIdCounter += 1;
  return `${prefix}-button-${templateButtonClientIdCounter}`;
}

function withTemplateButtonClientId<T extends object>(
  button: T & { clientId?: string },
  prefix: "whatsapp" | "telegram"
): T & { clientId: string } {
  return {
    ...button,
    clientId: button.clientId || createTemplateButtonClientId(prefix),
  };
}

function bindTemplateSelectField(field: {
  value: unknown;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return {
    value:
      typeof field.value === "string" && field.value ? field.value : undefined,
    onValueChange: field.onChange,
    onOpenChange: (open: boolean) => {
      if (!open) field.onBlur();
    },
  };
}

/** FormControl's slot must wrap the SelectTrigger directly. */
function TemplateSelectTrigger({ placeholder }: { placeholder?: string }) {
  return (
    <FormControl>
      <SelectTrigger className={TEMPLATE_FORM_SELECT_TRIGGER_CLASS}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
    </FormControl>
  );
}

const HEADER_FORMAT_OPTIONS = [
  ["TEXT", "form.text"],
  ["IMAGE", "form.image"],
  ["VIDEO", "form.video"],
  ["DOCUMENT", "form.document"],
] as const;
const BUTTON_TYPE_OPTIONS = [
  ["QUICK_REPLY", "form.quickReply"],
  ["URL", "form.url"],
  ["PHONE_NUMBER", "form.phoneNumber"],
  ["FLOW", "form.flow"],
  ["REQUEST_CONTACT_INFO", "form.requestContactInfo"],
] as const;
const FLOW_ACTION_OPTIONS = [
  ["navigate", "form.flowActionNavigate"],
  ["data_exchange", "form.flowActionDataExchange"],
] as const;

function toFormString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function toOptionalFormString(value: unknown): string | undefined {
  const text = toFormString(value);
  return text ? text : undefined;
}

function normalizeWhatsAppTemplateButtonForForm(
  button: WhatsAppTemplateButtonFormValue
): WhatsAppTemplateButtonFormValue {
  const base = {
    ...button,
    text: toFormString(button.text),
    url: toOptionalFormString(button.url),
    phone_number: toOptionalFormString(button.phone_number),
    flow_id: toOptionalFormString(button.flow_id),
    flow_name: toOptionalFormString(button.flow_name),
    flow_json: toOptionalFormString(button.flow_json),
    navigate_screen: toOptionalFormString(button.navigate_screen),
  };

  if (base.type !== "FLOW") {
    return base;
  }

  return {
    ...base,
    flow_action:
      base.flow_action === "data_exchange" ? "data_exchange" : "navigate",
  };
}

type WhatsAppTextFieldName = "bodyText" | "headerText";

type WhatsAppFormatControl = {
  key: "bold" | "italic" | "strikethrough" | "monospace";
  icon: LucideIcon;
  labelKey: string;
  start: string;
  end: string;
};

const WHATSAPP_FORMAT_CONTROLS: WhatsAppFormatControl[] = [
  {
    key: "bold",
    icon: Bold,
    labelKey: "form.formatBold",
    start: "*",
    end: "*",
  },
  {
    key: "italic",
    icon: Italic,
    labelKey: "form.formatItalic",
    start: "_",
    end: "_",
  },
  {
    key: "strikethrough",
    icon: Strikethrough,
    labelKey: "form.formatStrikethrough",
    start: "~",
    end: "~",
  },
  {
    key: "monospace",
    icon: Code,
    labelKey: "form.formatMonospace",
    start: "```",
    end: "```",
  },
];

const WHATSAPP_TEMPLATE_EXAMPLE_VARS = {
  v1: "{{1}}",
  v2: "{{2}}",
} as const;

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types || []).includes("Files")) return true;
  return Array.from(dataTransfer.items || []).some(
    item => item.kind === "file"
  );
}

function getFirstFileFromDataTransfer(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return null;
  const fileFromList = Array.from(dataTransfer.files || [])[0];
  if (fileFromList) return fileFromList;

  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  return null;
}

function getHeaderMediaValidationMessage(
  issue: WhatsAppTemplateHeaderMediaValidationIssue,
  t: (key: string) => string
) {
  if (issue === "templateVideoTooLarge") {
    return t("form.templateVideoTooLarge");
  }
  return t("form.templateVideoUnsupported");
}

function areTemplateEditorValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readHeaderMediaUploadResponse(
  response: Response
): Promise<HeaderMediaUploadReadResult> {
  if (typeof response.text === "function") {
    const rawText = await response.text().catch(() => "");
    if (!rawText.trim()) {
      return { payload: null, rawText };
    }

    try {
      return {
        payload: JSON.parse(rawText) as HeaderMediaUploadResponse,
        rawText,
      };
    } catch {
      return { payload: null, rawText };
    }
  }

  if (typeof response.json === "function") {
    const payload = (await response
      .json()
      .catch(() => null)) as HeaderMediaUploadResponse | null;
    return {
      payload,
      rawText: payload ? JSON.stringify(payload) : "",
    };
  }

  return { payload: null, rawText: "" };
}

function getHeaderMediaUploadErrorMessage(params: {
  response: Response;
  payload: HeaderMediaUploadResponse | null;
  rawText: string;
  fallback: string;
}): string {
  const providerMessage = params.payload?.error?.trim();
  if (providerMessage) return providerMessage;

  if (params.response.status === 413) {
    return "Media upload request is too large for the current upload endpoint. Try a smaller file or choose an existing uploaded asset.";
  }

  if (params.rawText.trim().startsWith("<")) {
    return `Media upload failed with HTTP ${params.response.status}. The upload endpoint returned HTML instead of JSON.`;
  }

  if (!params.response.ok) {
    return `Media upload failed with HTTP ${params.response.status}.`;
  }

  return params.fallback;
}

function readDirectHeaderMediaUpload(params: {
  payload: HeaderMediaUploadResponse | null;
}): {
  bucket: string;
  path: string;
  token: string;
  mediaUrl: string;
} | null {
  const bucket =
    typeof params.payload?.upload?.bucket === "string"
      ? params.payload.upload.bucket
      : "";
  const path =
    typeof params.payload?.upload?.path === "string"
      ? params.payload.upload.path
      : "";
  const token =
    typeof params.payload?.upload?.token === "string"
      ? params.payload.upload.token
      : "";
  const mediaUrl =
    typeof params.payload?.media?.url === "string"
      ? params.payload.media.url.trim()
      : "";

  if (!bucket || !path || !token || !mediaUrl) return null;
  return {
    bucket,
    path,
    token,
    mediaUrl,
  };
}

async function uploadWhatsAppTemplateMediaSampleFile(params: {
  workspaceId: string;
  file: File;
  format: "IMAGE" | "VIDEO" | "DOCUMENT";
  signal?: AbortSignal;
  fallbackError: string;
  mediaExampleLabel: string;
}): Promise<UploadedHeaderMedia> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(
      params.workspaceId
    )}/whatsapp-template-header-media`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "direct",
        fileName: params.file.name || "template-media",
        fileSize: params.file.size,
        format: params.format,
        mimeType: params.file.type || "application/octet-stream",
      }),
      signal: params.signal,
    }
  );
  const { payload, rawText } = await readHeaderMediaUploadResponse(response);
  const directUpload = readDirectHeaderMediaUpload({ payload });

  if (!response.ok || !directUpload) {
    throw new Error(
      getHeaderMediaUploadErrorMessage({
        response,
        payload,
        rawText,
        fallback: params.fallbackError,
      })
    );
  }

  const supabase = createSupabaseBrowserClient();
  const { error: directUploadError } = await supabase.storage
    .from(directUpload.bucket)
    .uploadToSignedUrl(directUpload.path, directUpload.token, params.file, {
      contentType: params.file.type || "application/octet-stream",
      upsert: false,
    });

  if (directUploadError) {
    throw new Error(
      `${params.file.name || params.mediaExampleLabel}: ${directUploadError.message}`
    );
  }

  const fileName =
    typeof payload?.media?.fileName === "string" &&
    payload.media.fileName.trim()
      ? payload.media.fileName.trim()
      : params.file.name || params.mediaExampleLabel;
  const fileSize =
    typeof payload?.media?.fileSize === "number"
      ? payload.media.fileSize
      : params.file.size;
  const mimeType =
    typeof payload?.media?.mimeType === "string"
      ? payload.media.mimeType
      : params.file.type || undefined;

  return {
    url: directUpload.mediaUrl,
    fileName,
    fileSize,
    mimeType,
  };
}

export function TemplateEditorForm({
  template,
  workspaceId,
  onSuccess,
  onCancel,
  className,
  title,
  layout = "default",
  platformScope = "all",
  reopenSearchParams,
}: TemplateEditorFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const submissionOwnerRef = useRef<{ pending: boolean } | null>(null);
  useEffect(() => {
    const owner = { pending: false };
    submissionOwnerRef.current = owner;
    return () => {
      if (submissionOwnerRef.current === owner)
        submissionOwnerRef.current = null;
    };
  }, []);
  const tTemplates = useTranslations("templates");
  const templateMeta = template;
  const metaTemplateId =
    templateMeta?.metaId ||
    (templateMeta?.channel !== "telegram" ? templateMeta?.id : undefined);
  const dbTemplateId =
    templateMeta?.dbId ||
    (templateMeta?.channel === "telegram" || templateMeta?.channel === "both"
      ? templateMeta?.id
      : undefined);
  const isEdit = Boolean(metaTemplateId || dbTemplateId);
  const buttonValidationMessages = useMemo<TemplateButtonValidationMessages>(
    () => ({
      buttonTextRequired: tTemplates("form.errors.buttonTextRequired"),
      buttonTextMax: tTemplates("form.errors.buttonTextMax"),
      invalidUrl: tTemplates("form.errors.invalidUrl"),
      urlRequired: tTemplates("form.errors.urlRequired"),
      phoneRequired: tTemplates("form.errors.phoneRequired"),
      flowRequired: tTemplates("form.errors.flowRequired"),
      flowNavigateScreenRequired: tTemplates(
        "form.errors.flowNavigateScreenRequired"
      ),
      maxButtons: tTemplates("alerts.max3Buttons"),
      maxOneFlowButton: tTemplates("form.errors.maxOneFlowButton"),
      maxOnePhoneButton: tTemplates("form.errors.maxOnePhoneButton"),
      maxTwoUrlButtons: tTemplates("form.errors.maxTwoUrlButtons"),
      flowNameRequired: tTemplates("form.errors.flowNameRequired"),
      flowNameMax: tTemplates("form.errors.flowNameMax"),
      createFlowFailed: tTemplates("form.createFlowFailed"),
    }),
    [tTemplates]
  );
  const templateButtonsSchema = useMemo(
    () => createTemplateButtonsSchema(buttonValidationMessages),
    [buttonValidationMessages]
  );
  const templateButtonTypeLimitSchema = useMemo(
    () => createTemplateButtonTypeLimitSchema(buttonValidationMessages),
    [buttonValidationMessages]
  );
  const whatsAppFlowNameSchema = useMemo(
    () => createWhatsAppFlowNameSchema(buttonValidationMessages),
    [buttonValidationMessages]
  );
  const whatsAppFlowCreateResponseSchema = useMemo(
    () => createWhatsAppFlowCreateResponseSchema(buttonValidationMessages),
    [buttonValidationMessages]
  );

  const getDefaultValues = (
    source?: (WhatsAppTemplate & EditableTemplate) | undefined
  ): TemplateFormValues => ({
    name: source?.name || "",
    targetPlatform:
      platformScope === "whatsapp" ? "whatsapp" : source?.channel || "whatsapp",
    language:
      normalizeWhatsAppTemplateLanguageCode(source?.language) ||
      source?.language ||
      "en",
    category: source?.category || "MARKETING",
    marketingMaxPriceEnabled: Boolean(source?.optimization_spec),
    marketingMaxPriceBidAmount: source?.optimization_spec?.bid_amount ?? "",
    hasHeader: !!source?.components?.find(c => c.type === "HEADER"),
    headerFormat:
      source?.components?.find(c => c.type === "HEADER")?.format || "TEXT",
    headerText: source?.components?.find(c => c.type === "HEADER")?.text || "",
    headerMediaExample: getWhatsAppTemplateHeaderMediaExample(
      source?.components
    ),
    bodyText: source?.components?.find(c => c.type === "BODY")?.text || "",
    authSecurityRecommendation:
      source?.components?.find(c => c.type === "BODY")
        ?.add_security_recommendation ?? true,
    authCodeExpirationMinutes:
      source?.components?.find(c => c.type === "FOOTER")
        ?.code_expiration_minutes ?? "",
    variableExamples: readWhatsAppTemplateNamedParamExamples(
      source?.components
    ),
    hasFooter: !!source?.components?.find(c => c.type === "FOOTER"),
    footerText: source?.components?.find(c => c.type === "FOOTER")?.text || "",
    hasButtons:
      !!source?.components?.find(c => c.type === "BUTTONS") &&
      !source?.components?.find(c => c.type === "CAROUSEL"),
    buttons:
      source?.components
        ?.find(c => c.type === "BUTTONS")
        ?.buttons?.map(button =>
          normalizeWhatsAppTemplateButtonForForm(
            withTemplateButtonClientId(
              button as WhatsAppTemplateButtonFormValue,
              "whatsapp"
            )
          )
        ) || [],
    hasCarousel: Boolean(
      getWhatsAppTemplateCarouselComponent(source?.components)
    ),
    carouselHeaderFormat:
      parseTemplateCarouselCardsFromComponent(
        getWhatsAppTemplateCarouselComponent(source?.components)
      )[0]?.headerFormat || "IMAGE",
    carouselCards: parseTemplateCarouselCardsFromComponent(
      getWhatsAppTemplateCarouselComponent(source?.components)
    ),
    telegramText: source?.telegramData?.text || "",
    telegramParseMode: source?.telegramData?.parseMode || "None",
    hasTelegramButtons: Boolean(source?.telegramData?.inlineKeyboard),
    telegramButtons:
      source?.telegramData?.inlineKeyboard?.flat().map(button =>
        withTemplateButtonClientId(
          {
            text: button.text,
            url: button.url,
            callbackData: button.callbackData,
          },
          "telegram"
        )
      ) || [],
  });

  const templateFormSchema = useMemo(() => {
    const whatsappSchema = z.object({
      language: z
        .string()
        .min(2, tTemplates("form.errors.langRequired"))
        .refine(
          value => Boolean(normalizeWhatsAppTemplateLanguageCode(value)),
          tTemplates("form.errors.langRequired")
        ),
      category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
      marketingMaxPriceEnabled: z.boolean().optional(),
      marketingMaxPriceBidAmount: z.union([z.string(), z.number()]).optional(),
      hasHeader: z.boolean(),
      headerFormat: z
        .enum(["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "LOCATION"])
        .optional(),
      // Checked in superRefine, only while the template sends a text header.
      headerText: z.string().optional(),
      headerMediaExample: z.string().trim().optional(),
      bodyText: z.string(),
      authSecurityRecommendation: z.boolean().optional(),
      authCodeExpirationMinutes: z
        .union([z.number(), z.literal("")])
        .optional(),
      variableExamples: z.record(z.string()).optional(),
      hasFooter: z.boolean(),
      footerText: z
        .string()
        .max(60, tTemplates("form.errors.footerMax"))
        .optional(),
      hasButtons: z.boolean(),
      buttons: templateButtonsSchema.optional(),
      hasCarousel: z.boolean().optional(),
      carouselHeaderFormat: z.enum(["IMAGE", "VIDEO"]).optional(),
      carouselCards: z.array(z.any()).optional(),
    });

    const telegramSchema = z.object({
      telegramText: z.string().max(4096, tTemplates("form.errors.telegramMax")),
      telegramParseMode: z.enum(["None", "Markdown", "HTML"]).optional(),
      hasTelegramButtons: z.boolean(),
      telegramButtons: z
        .array(
          z.object({
            clientId: z.string().optional(),
            text: z
              .string()
              .min(1, tTemplates("form.errors.buttonTextRequired"))
              .max(64),
            url: z
              .string()
              .url(tTemplates("form.errors.invalidUrl"))
              .optional(),
            callbackData: z.string().max(64).optional(),
          })
        )
        .optional(),
    });

    const baseSchema = z.object({
      name: z
        .string()
        .min(1, tTemplates("form.errors.nameRequired"))
        .max(512, tTemplates("form.errors.nameMax"))
        .refine(
          val => isValidTemplateName(val),
          tTemplates("form.errors.nameAlphanumeric")
        ),
      targetPlatform: z.enum(["whatsapp", "telegram", "both"]),
    });

    return baseSchema
      .merge(whatsappSchema.partial())
      .merge(telegramSchema.partial())
      .superRefine((data, ctx) => {
        if (
          data.targetPlatform === "whatsapp" ||
          data.targetPlatform === "both"
        ) {
          if (!data.language) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: tTemplates("form.errors.langRequired"),
              path: ["language"],
            });
          }
          if (!data.category) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: tTemplates("form.errors.categoryRequired"),
              path: ["category"],
            });
          }
          if (data.marketingMaxPriceEnabled) {
            if (data.category !== "MARKETING") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: tTemplates("form.errors.marketingMaxPriceCategory"),
                path: ["marketingMaxPriceEnabled"],
              });
            }
            const bidAmount = Number(data.marketingMaxPriceBidAmount);
            if (!Number.isSafeInteger(bidAmount) || bidAmount <= 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: tTemplates("form.errors.marketingMaxPriceBidAmount"),
                path: ["marketingMaxPriceBidAmount"],
              });
            }
          }
          const headerText = data.headerText || "";
          if (
            headerText &&
            isTemplateFormTextHeaderActive(data as TemplateFormValues)
          ) {
            const headerMessages: string[] = [];
            if (headerText.length > 60)
              headerMessages.push(tTemplates("form.errors.headerMax"));
            for (const validation of [
              hasVariableAtStartOrEnd(headerText),
              hasValidVariableNumbering(headerText),
            ]) {
              if (!validation.valid)
                headerMessages.push(tTemplates(validation.errorKey!));
            }
            // Meta takes one parameter in a text header.
            if (extractTemplateVariables(headerText).length > 1)
              headerMessages.push(tTemplates("form.errors.headerOneVariable"));
            headerMessages.forEach(message =>
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message,
                path: ["headerText"],
              })
            );
          }
          if (
            data.category !== "AUTHENTICATION" &&
            !data.hasCarousel &&
            data.hasHeader &&
            isWhatsAppTemplateMediaHeaderFormat(data.headerFormat) &&
            !data.headerMediaExample?.trim()
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: tTemplates("form.errors.headerMediaExampleRequired"),
              path: ["headerMediaExample"],
            });
          }
          if (!data.hasCarousel && data.hasButtons) {
            (data.buttons || []).forEach((button, index) => {
              if (
                button?.type === "URL" &&
                button.url?.trim() &&
                !hasValidTemplateUrlVariablePlacement(button.url)
              ) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: tTemplates("form.errors.urlVariablePlacement"),
                  path: ["buttons", index, "url"],
                });
              }
            });
          }
          if (data.hasCarousel) {
            if (data.category !== "MARKETING") {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: tTemplates("form.errors.carouselMarketingOnly"),
                path: ["hasCarousel"],
              });
            }
            const cards = (data.carouselCards ||
              []) as TemplateCarouselCardFormValue[];
            if (
              cards.length < WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN ||
              cards.length > WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MAX
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: tTemplates("form.errors.carouselCardCount"),
                path: ["carouselCards"],
              });
            }
            cards.forEach((card, index) => {
              if (!card?.headerMediaExample?.trim()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: tTemplates("form.errors.carouselCardMediaRequired"),
                  path: ["carouselCards", index, "headerMediaExample"],
                });
              }
              if (!card?.bodyText?.trim()) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: tTemplates("form.errors.carouselCardBodyRequired"),
                  path: ["carouselCards", index, "bodyText"],
                });
              } else if (!hasValidVariableNumbering(card.bodyText).valid) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: tTemplates("form.variableNumberingError"),
                  path: ["carouselCards", index, "bodyText"],
                });
              }
              const buttons = card?.buttons || [];
              if (buttons.length === 0) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: tTemplates("form.errors.carouselCardButtonRequired"),
                  path: ["carouselCards", index, "buttons"],
                });
              }
              buttons.forEach((button, buttonIndex) => {
                if (!button?.text?.trim()) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: tTemplates("form.errors.buttonTextRequired"),
                    path: [
                      "carouselCards",
                      index,
                      "buttons",
                      buttonIndex,
                      "text",
                    ],
                  });
                }
                if (button?.type === "URL" && !button.url?.trim()) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: tTemplates("form.errors.urlRequired"),
                    path: [
                      "carouselCards",
                      index,
                      "buttons",
                      buttonIndex,
                      "url",
                    ],
                  });
                } else if (
                  button?.type === "URL" &&
                  !hasValidTemplateUrlVariablePlacement(button.url || "")
                ) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: tTemplates("form.errors.urlVariablePlacement"),
                    path: [
                      "carouselCards",
                      index,
                      "buttons",
                      buttonIndex,
                      "url",
                    ],
                  });
                }
                if (
                  button?.type === "PHONE_NUMBER" &&
                  !button.phone_number?.trim()
                ) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: tTemplates("form.errors.phoneRequired"),
                    path: [
                      "carouselCards",
                      index,
                      "buttons",
                      buttonIndex,
                      "phone_number",
                    ],
                  });
                }
              });
            });
          }
          if (
            data.category !== "AUTHENTICATION" &&
            (!data.bodyText || data.bodyText.trim().length === 0)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: tTemplates("form.errors.bodyRequired"),
              path: ["bodyText"],
            });
          }
          if (data.category === "AUTHENTICATION") {
            const expiry = data.authCodeExpirationMinutes;
            if (
              expiry !== undefined &&
              expiry !== "" &&
              (!Number.isInteger(expiry) || expiry < 1 || expiry > 90)
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: tTemplates("form.errors.authExpiryRange"),
                path: ["authCodeExpirationMinutes"],
              });
            }
          } else {
            const body = data.bodyText || "";
            if (body.length > 1024)
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: tTemplates("form.errors.bodyMax"),
                path: ["bodyText"],
              });
            for (const validation of [
              hasVariableAtStartOrEnd(body),
              hasValidVariableNumbering(body),
            ]) {
              if (!validation.valid)
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: tTemplates(
                    validation.errorKey || "form.errors.bodyRequired"
                  ),
                  path: ["bodyText"],
                });
            }
          }
          getTemplateFormVariableFormatIssues(
            data as TemplateFormValues
          ).forEach(({ path, issue }) => {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: tTemplates(
                issue === "mixed"
                  ? "form.errors.variablesMixed"
                  : "form.errors.variableNameInvalid"
              ),
              path,
            });
          });
        }

        if (
          data.targetPlatform === "telegram" ||
          data.targetPlatform === "both"
        ) {
          if (!data.telegramText || data.telegramText.trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: tTemplates("form.errors.telegramRequired"),
              path: ["telegramText"],
            });
          }
        }
      });
  }, [tTemplates, templateButtonsSchema]);

  const form = useForm<TemplateFormValues>({
    resolver: zodResolver(templateFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    criteriaMode: "all",
    defaultValues: getDefaultValues(template),
  });

  const {
    fields: buttonFields,
    append: appendButtonField,
    remove: removeButtonField,
    update: updateButtonField,
    replace: replaceButtonFields,
  } = useFieldArray({
    control: form.control,
    name: "buttons",
  });
  const {
    fields: telegramButtonFields,
    append: appendTelegramButtonField,
    remove: removeTelegramButtonField,
  } = useFieldArray({
    control: form.control,
    name: "telegramButtons",
  });
  const carouselFieldArray = useFieldArray({
    control: form.control,
    name: "carouselCards",
  });
  const { replace: replaceCarouselCards } = carouselFieldArray;

  const [
    watchedTargetPlatform,
    watchedButtons,
    hasHeader,
    hasFooter,
    hasButtons,
    hasCarousel,
    headerFormat,
    watchedHeaderMediaExample,
    watchedHeaderText,
    watchedBodyText,
    watchedFooterText,
    watchedTelegramText,
    watchedHasTelegramButtons,
    watchedTelegramButtons,
    watchedCategory,
    watchedMarketingMaxPriceEnabled,
    watchedCarouselHeaderFormat,
    watchedCarouselCards,
    watchedAuthSecurityRecommendation,
    watchedAuthCodeExpirationMinutes,
    watchedLanguage,
    watchedName,
  ] = useWatch({
    control: form.control,
    name: [
      "targetPlatform",
      "buttons",
      "hasHeader",
      "hasFooter",
      "hasButtons",
      "hasCarousel",
      "headerFormat",
      "headerMediaExample",
      "headerText",
      "bodyText",
      "footerText",
      "telegramText",
      "hasTelegramButtons",
      "telegramButtons",
      "category",
      "marketingMaxPriceEnabled",
      "carouselHeaderFormat",
      "carouselCards",
      "authSecurityRecommendation",
      "authCodeExpirationMinutes",
      "language",
      "name",
    ],
  });
  const isWhatsAppOnly = platformScope === "whatsapp";
  const targetPlatform = (
    isWhatsAppOnly ? "whatsapp" : watchedTargetPlatform || "whatsapp"
  ) as TemplateChannel;
  const buttons = useMemo(() => watchedButtons || [], [watchedButtons]);
  const telegramButtons = useMemo(
    () => watchedTelegramButtons || [],
    [watchedTelegramButtons]
  );
  const headerMediaExample = watchedHeaderMediaExample || "";
  const headerText = watchedHeaderText || "";
  const bodyText = watchedBodyText || "";
  const footerText = watchedFooterText || "";
  const telegramText = watchedTelegramText || "";
  const hasTelegramButtons = Boolean(watchedHasTelegramButtons);
  const selectedCategory = watchedCategory || "MARKETING";
  const marketingMaxPriceEnabled = Boolean(watchedMarketingMaxPriceEnabled);
  const carouselCards = useMemo(
    () => watchedCarouselCards || [],
    [watchedCarouselCards]
  );
  const carouselHeaderFormat =
    watchedCarouselHeaderFormat === "VIDEO" ? "VIDEO" : "IMAGE";
  const hasFlowButton = buttons.some(button => button.type === "FLOW");
  const hasMediaHeader = isWhatsAppTemplateMediaHeaderFormat(headerFormat);
  const headerMediaFormat = isWhatsAppTemplateMediaHeaderFormat(headerFormat)
    ? headerFormat
    : null;
  const headerAssetKind =
    headerFormat === "IMAGE"
      ? "image"
      : headerFormat === "VIDEO"
        ? "video"
        : null;
  const useModalLayout = layout === "modal";
  const flowScreenIdsToEnsureKey = useMemo(
    () =>
      Array.from(
        new Set(
          buttons
            .filter(
              button =>
                button.type === "FLOW" &&
                (button.flow_action || "navigate") === "navigate" &&
                Boolean(toOptionalFormString(button.flow_id))
            )
            .map(button => toOptionalFormString(button.flow_id))
        )
      )
        .filter((flowId): flowId is string => Boolean(flowId))
        .join("|"),
    [buttons]
  );

  const showWhatsApp =
    targetPlatform === "whatsapp" || targetPlatform === "both";
  const templateStatus = template?.status || "PENDING";
  const canEditMetaTemplate =
    !isEdit || !showWhatsApp || canEditTemplate(templateStatus);
  const metaEditDisabledReason =
    isEdit && showWhatsApp && !canEditMetaTemplate
      ? tTemplates("form.editDisabledStatus", { status: templateStatus })
      : null;

  const bodyVars = extractTemplateVariables(bodyText);
  const headerVars = extractTemplateVariables(headerText);
  const allVariableKeys = useMemo(
    () =>
      collectTemplateVariableKeys({
        headerText: selectedCategory === "AUTHENTICATION" ? "" : headerText,
        bodyText: selectedCategory === "AUTHENTICATION" ? "" : bodyText,
        telegramText,
        buttons: selectedCategory === "AUTHENTICATION" ? [] : buttons,
        carouselCards:
          selectedCategory === "AUTHENTICATION" ? [] : carouselCards,
      }),
    [
      headerText,
      bodyText,
      telegramText,
      buttons,
      carouselCards,
      selectedCategory,
    ]
  );

  const [variableRenameDraft, setVariableRenameDraft] = useState<
    Record<string, string>
  >({});
  const [availableFlows, setAvailableFlows] = useState<WhatsAppFlowOption[]>(
    []
  );
  const [flowScreenOptionsById, setFlowScreenOptionsById] = useState<
    Record<string, string[]>
  >({});
  const [flowScreenErrorsById, setFlowScreenErrorsById] = useState<
    Record<string, string | null>
  >({});
  const [flowScreenLoadingById, setFlowScreenLoadingById] = useState<
    Record<string, boolean>
  >({});
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [flowsLoaded, setFlowsLoaded] = useState(false);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [creatingFlow, setCreatingFlow] = useState(false);
  const [newFlowName, setNewFlowName] = useState("");
  const headerMediaInputRef = useRef<HTMLInputElement | null>(null);
  const [headerMediaUploading, setHeaderMediaUploading] = useState(false);
  const [headerMediaDragActive, setHeaderMediaDragActive] = useState(false);
  const [uploadedHeaderMedia, setUploadedHeaderMedia] =
    useState<UploadedHeaderMedia | null>(null);
  const [headerMediaUploadError, setHeaderMediaUploadError] = useState<
    string | null
  >(null);
  const [isHeaderAssetPickerOpen, setIsHeaderAssetPickerOpen] = useState(false);
  const [carouselAssetCardId, setCarouselAssetCardId] = useState<string | null>(
    null
  );
  const headerMediaUploadAbortRef = useRef<AbortController | null>(null);
  const headerMediaUploadSeqRef = useRef(0);
  const flowRequestsSeqRef = useRef(0);
  const flowsLoadPromiseRef = useRef<Promise<void> | null>(null);
  const flowScreenLoadPromisesRef = useRef<Record<string, Promise<string[]>>>(
    {}
  );
  const whatsappTextFieldRefs = useRef<
    Partial<
      Record<
        WhatsAppTextFieldName,
        HTMLTextAreaElement | HTMLInputElement | null
      >
    >
  >({});
  const hydratedTemplateRef = useRef(template);
  const flowsWorkspaceRef = useRef(workspaceId);

  const livePreviewTemplate = useMemo(
    () => ({
      id: template?.id,
      metaId: templateMeta?.metaId,
      dbId: templateMeta?.dbId,
      name: watchedName || template?.name || "template",
      language: watchedLanguage || template?.language || "en",
      category: form.getValues("category") || template?.category || "UTILITY",
      status: template?.status || "PENDING",
      channel: targetPlatform,
      components: buildWhatsAppTemplateComponentsFromFormValues(
        {
          ...form.getValues(),
          language: watchedLanguage || template?.language || "en",
          authSecurityRecommendation: watchedAuthSecurityRecommendation,
          authCodeExpirationMinutes: watchedAuthCodeExpirationMinutes,
          hasHeader,
          headerFormat,
          headerText,
          headerMediaExample,
          bodyText,
          hasFooter,
          footerText,
          hasButtons: selectedCategory === "AUTHENTICATION" ? true : hasButtons,
          buttons:
            selectedCategory === "AUTHENTICATION"
              ? [
                  {
                    type: "OTP" as const,
                    otp_type: "COPY_CODE" as const,
                    text:
                      buttons.find(button => button.type === "OTP")?.text || "",
                  },
                ]
              : buttons,
          category: selectedCategory,
          hasCarousel:
            selectedCategory === "MARKETING" ? Boolean(hasCarousel) : false,
          carouselHeaderFormat,
          carouselCards,
        },
        { includeIncompleteCarousel: true, forPreview: true }
      ),
      telegramData: {
        text: telegramText,
        parseMode: form.getValues("telegramParseMode") || "None",
        inlineKeyboard: [],
      },
    }),
    [
      bodyText,
      buttons,
      carouselCards,
      carouselHeaderFormat,
      footerText,
      form,
      hasButtons,
      hasCarousel,
      hasFooter,
      hasHeader,
      headerFormat,
      headerMediaExample,
      headerText,
      selectedCategory,
      targetPlatform,
      telegramText,
      template,
      templateMeta?.dbId,
      templateMeta?.metaId,
      watchedAuthSecurityRecommendation,
      watchedAuthCodeExpirationMinutes,
      watchedLanguage,
      watchedName,
    ]
  );

  useEffect(() => {
    setVariableRenameDraft(prev => {
      const next: Record<string, string> = {};
      allVariableKeys.forEach(key => {
        next[key] = prev[key] || key;
      });
      return next;
    });
  }, [allVariableKeys]);

  useEffect(() => {
    if (selectedCategory === "MARKETING") return;

    if (form.getValues("marketingMaxPriceEnabled")) {
      form.setValue("marketingMaxPriceEnabled", false, {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });
      form.setValue("marketingMaxPriceBidAmount", "", {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });
    }

    if (form.getValues("hasCarousel")) {
      form.setValue("hasCarousel", false, {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });
    }
  }, [form, selectedCategory]);

  useEffect(() => {
    if (selectedCategory !== "AUTHENTICATION") return;

    const currentButtons = form.getValues("buttons") || [];
    const authButton = currentButtons.find(
      button => button.type === "OTP" && button.otp_type === "COPY_CODE"
    );
    form.setValue("hasHeader", false, { shouldDirty: true });
    form.setValue("hasFooter", false, { shouldDirty: true });
    form.setValue("hasButtons", true, { shouldDirty: true });
    form.setValue("hasCarousel", false, { shouldDirty: true });
    replaceButtonFields([
      withTemplateButtonClientId(
        {
          type: "OTP" as const,
          otp_type: "COPY_CODE" as const,
          text: authButton?.text || "",
        },
        "whatsapp"
      ),
    ]);
    if (form.formState.isSubmitted) {
      void form.trigger("buttons");
    }
  }, [form, replaceButtonFields, selectedCategory]);

  useEffect(
    () => () => {
      headerMediaUploadAbortRef.current?.abort();
    },
    []
  );

  const uploadHeaderMediaFile = async (file: File | null | undefined) => {
    if (!file) return;

    const format = headerMediaFormat;
    if (!format) return;

    const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
      format,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
    });
    if (validationIssue) {
      const message = getHeaderMediaValidationMessage(
        validationIssue,
        tTemplates
      );
      setHeaderMediaUploadError(message);
      toast.error(message);
      if (headerMediaInputRef.current) {
        headerMediaInputRef.current.value = "";
      }
      return;
    }

    headerMediaUploadAbortRef.current?.abort();
    const uploadController = new AbortController();
    const uploadSeq = headerMediaUploadSeqRef.current + 1;
    headerMediaUploadAbortRef.current = uploadController;
    headerMediaUploadSeqRef.current = uploadSeq;
    setHeaderMediaUploading(true);
    setHeaderMediaUploadError(null);

    try {
      const uploaded = await uploadWhatsAppTemplateMediaSampleFile({
        workspaceId,
        file,
        format,
        signal: uploadController.signal,
        fallbackError: tTemplates("form.mediaUploadFailed"),
        mediaExampleLabel: tTemplates("form.mediaExample"),
      });

      if (uploadController.signal.aborted) return;
      if (headerMediaUploadSeqRef.current !== uploadSeq) return;

      form.setValue("headerMediaExample", uploaded.url, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: form.formState.isSubmitted,
      });
      setUploadedHeaderMedia(uploaded);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : tTemplates("form.mediaUploadFailed");
      setHeaderMediaUploadError(message);
      toast.error(message);
    } finally {
      if (headerMediaUploadSeqRef.current === uploadSeq) {
        setHeaderMediaUploading(false);
        if (headerMediaUploadAbortRef.current === uploadController) {
          headerMediaUploadAbortRef.current = null;
        }
        if (headerMediaInputRef.current) {
          headerMediaInputRef.current.value = "";
        }
      }
    }
  };

  const uploadCarouselCardMedia = async (
    file: File
  ): Promise<string | null> => {
    const format =
      form.getValues("carouselHeaderFormat") === "VIDEO" ? "VIDEO" : "IMAGE";
    const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
      format,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
    });
    if (validationIssue) {
      toast.error(getHeaderMediaValidationMessage(validationIssue, tTemplates));
      return null;
    }

    try {
      const uploaded = await uploadWhatsAppTemplateMediaSampleFile({
        workspaceId,
        file,
        format,
        fallbackError: tTemplates("form.mediaUploadFailed"),
        mediaExampleLabel: tTemplates("form.mediaExample"),
      });
      return uploaded.url;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : tTemplates("form.mediaUploadFailed")
      );
      return null;
    }
  };

  const handleSelectHeaderAsset = (asset: CreativeAsset) => {
    const format = headerMediaFormat;
    if (
      !format ||
      !headerAssetKind ||
      asset.kind !== headerAssetKind ||
      !asset.url
    ) {
      const message =
        headerFormat === "VIDEO"
          ? tTemplates("form.templateVideoUnsupported")
          : tTemplates("form.mediaUploadFailed");
      setHeaderMediaUploadError(message);
      toast.error(message);
      return;
    }
    const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
      format,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.fileSize,
    });
    if (validationIssue) {
      const message = getHeaderMediaValidationMessage(
        validationIssue,
        tTemplates
      );
      setHeaderMediaUploadError(message);
      toast.error(message);
      return;
    }

    headerMediaUploadAbortRef.current?.abort();
    headerMediaUploadAbortRef.current = null;
    headerMediaUploadSeqRef.current += 1;
    setHeaderMediaUploading(false);
    form.setValue("headerMediaExample", asset.url, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: form.formState.isSubmitted,
    });
    setUploadedHeaderMedia({
      url: asset.url,
      fileName:
        asset.fileName || asset.prompt?.slice(0, 48) || `asset-${asset.id}`,
      fileSize: asset.fileSize || undefined,
      mimeType: asset.mimeType || undefined,
    });
    setHeaderMediaUploadError(null);
    setIsHeaderAssetPickerOpen(false);
  };

  const isHeaderAssetSelectable = (asset: CreativeAsset) => {
    const format = headerMediaFormat;
    if (
      !format ||
      !headerAssetKind ||
      asset.kind !== headerAssetKind ||
      !asset.url
    ) {
      return false;
    }
    return !getWhatsAppTemplateHeaderMediaValidationIssue({
      format,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.fileSize,
    });
  };

  const isCarouselAssetSelectable = (asset: CreativeAsset) => {
    const expectedKind = carouselHeaderFormat === "VIDEO" ? "video" : "image";
    if (asset.kind !== expectedKind || !asset.url) {
      return false;
    }
    return !getWhatsAppTemplateHeaderMediaValidationIssue({
      format: carouselHeaderFormat,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.fileSize,
    });
  };

  const handleSelectCarouselCardAsset = (asset: CreativeAsset) => {
    if (!carouselAssetCardId) return;
    const expectedKind = carouselHeaderFormat === "VIDEO" ? "video" : "image";
    const url = asset.url;
    if (asset.kind !== expectedKind || !url) {
      toast.error(
        carouselHeaderFormat === "VIDEO"
          ? tTemplates("form.templateVideoUnsupported")
          : tTemplates("form.mediaUploadFailed")
      );
      return;
    }
    const validationIssue = getWhatsAppTemplateHeaderMediaValidationIssue({
      format: carouselHeaderFormat,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      size: asset.fileSize,
    });
    if (validationIssue) {
      toast.error(getHeaderMediaValidationMessage(validationIssue, tTemplates));
      return;
    }

    const cardIndex = (form.getValues("carouselCards") || []).findIndex(
      card => card.clientId === carouselAssetCardId
    );
    if (cardIndex >= 0) {
      form.setValue(`carouselCards.${cardIndex}.headerMediaExample`, url, {
        shouldDirty: true,
        shouldTouch: true,
        shouldValidate: form.formState.isSubmitted,
      });
    }
    setCarouselAssetCardId(null);
  };

  const handleHeaderMediaInputChange = (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    void uploadHeaderMediaFile(event.currentTarget.files?.[0]);
  };

  const handleHeaderMediaDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setHeaderMediaDragActive(true);
  };

  const handleHeaderMediaDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setHeaderMediaDragActive(false);
  };

  const handleHeaderMediaDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setHeaderMediaDragActive(false);
    void uploadHeaderMediaFile(
      getFirstFileFromDataTransfer(event.dataTransfer)
    );
  };

  const clearUploadedHeaderMedia = () => {
    headerMediaUploadAbortRef.current?.abort();
    headerMediaUploadAbortRef.current = null;
    headerMediaUploadSeqRef.current += 1;
    setHeaderMediaUploading(false);
    setUploadedHeaderMedia(null);
    setHeaderMediaUploadError(null);
    form.setValue("headerMediaExample", "", {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: form.formState.isSubmitted,
    });
  };

  const loadFlows = useCallback(
    (force = false) => {
      if (!force && flowsLoaded) {
        return Promise.resolve();
      }
      if (flowsLoadPromiseRef.current) {
        return flowsLoadPromiseRef.current;
      }

      const requestSeq = flowRequestsSeqRef.current + 1;
      flowRequestsSeqRef.current = requestSeq;
      const promise = (async () => {
        setFlowsLoading(true);
        setFlowsError(null);
        try {
          const result = await fetchWhatsAppFlowsList({
            workspaceId,
            limit: 200,
            force,
          });
          const data = result.data;

          if (!result.ok) {
            throw new Error(data?.error || tTemplates("form.loadFlowsFailed"));
          }

          const mappedFlows: WhatsAppFlowOption[] = Array.isArray(data?.flows)
            ? data.flows
                .filter(
                  (flow: unknown): flow is WhatsAppFlowOption =>
                    typeof flow === "object" &&
                    flow !== null &&
                    typeof (flow as { id?: string }).id === "string"
                )
                .map((flow: WhatsAppFlowOption) => ({
                  id: flow.id,
                  name: flow.name,
                  status: flow.status,
                }))
            : [];

          if (flowRequestsSeqRef.current !== requestSeq) return;
          setAvailableFlows(mappedFlows);
          setFlowsLoaded(true);
        } catch (error) {
          if (flowRequestsSeqRef.current !== requestSeq) return;
          setFlowsError(
            error instanceof Error
              ? error.message
              : tTemplates("form.loadFlowsFailed")
          );
        } finally {
          if (flowRequestsSeqRef.current === requestSeq) {
            setFlowsLoading(false);
          }
        }
      })();

      flowsLoadPromiseRef.current = promise;
      void promise.finally(() => {
        if (flowsLoadPromiseRef.current === promise) {
          flowsLoadPromiseRef.current = null;
        }
      });
      return promise;
    },
    [flowsLoaded, tTemplates, workspaceId]
  );

  const loadFlowScreenIds = useCallback(
    (flowId: string, force = false): Promise<string[]> => {
      const cachedScreens = flowScreenOptionsById[flowId];
      if (!force && cachedScreens) {
        return Promise.resolve(cachedScreens);
      }

      const inFlight = flowScreenLoadPromisesRef.current[flowId];
      if (inFlight) {
        return inFlight;
      }

      const requestSeq = flowRequestsSeqRef.current;
      const promise = (async () => {
        setFlowScreenLoadingById(prev => ({ ...prev, [flowId]: true }));
        setFlowScreenErrorsById(prev => ({ ...prev, [flowId]: null }));

        try {
          const params = new URLSearchParams({
            workspaceId,
            flowId,
            includeJson: "true",
          });
          const response = await fetch(
            `/api/whatsapp/flows?${params.toString()}`,
            {
              cache: "no-store",
            }
          );
          const data = (await response
            .json()
            .catch(() => null)) as WhatsAppFlowDetailsResponse | null;

          if (!response.ok) {
            throw new Error(
              data?.error || tTemplates("form.loadFlowScreensFailed")
            );
          }

          const screenIds = extractWhatsAppFlowScreenIds(data?.flowJson);
          if (screenIds.length === 0) {
            throw new Error(
              data?.flowJsonError || tTemplates("form.loadFlowScreensFailed")
            );
          }

          if (flowRequestsSeqRef.current !== requestSeq) return [];
          setFlowScreenOptionsById(prev => ({ ...prev, [flowId]: screenIds }));
          setFlowScreenErrorsById(prev => ({ ...prev, [flowId]: null }));
          return screenIds;
        } catch (error) {
          if (flowRequestsSeqRef.current !== requestSeq) return [];
          const message =
            error instanceof Error
              ? error.message
              : tTemplates("form.loadFlowScreensFailed");
          setFlowScreenErrorsById(prev => ({ ...prev, [flowId]: message }));
          return [];
        } finally {
          if (flowRequestsSeqRef.current === requestSeq) {
            setFlowScreenLoadingById(prev => ({ ...prev, [flowId]: false }));
          }
        }
      })();

      flowScreenLoadPromisesRef.current[flowId] = promise;
      void promise.finally(() => {
        if (flowScreenLoadPromisesRef.current[flowId] === promise) {
          delete flowScreenLoadPromisesRef.current[flowId];
        }
      });
      return promise;
    },
    [flowScreenOptionsById, tTemplates, workspaceId]
  );

  const handleFlowSelect = async (buttonIndex: number, flowId: string) => {
    form.setValue(`buttons.${buttonIndex}.flow_id`, flowId, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });

    const currentAction =
      form.getValues(`buttons.${buttonIndex}.flow_action`) || "navigate";
    if (!form.getValues(`buttons.${buttonIndex}.flow_action`)) {
      form.setValue(`buttons.${buttonIndex}.flow_action`, currentAction, {
        shouldDirty: true,
      });
    }

    if (currentAction !== "navigate") {
      return;
    }

    form.setValue(`buttons.${buttonIndex}.navigate_screen`, undefined, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });

    const screenIds = await loadFlowScreenIds(flowId);
    if (screenIds.length === 0) {
      return;
    }

    const currentScreen = form.getValues(
      `buttons.${buttonIndex}.navigate_screen`
    );
    if (!currentScreen || !screenIds.includes(currentScreen)) {
      form.setValue(`buttons.${buttonIndex}.navigate_screen`, screenIds[0], {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });
    }
  };

  const handleFlowActionChange = async (
    buttonIndex: number,
    value: "navigate" | "data_exchange",
    onChange: (value: "navigate" | "data_exchange") => void
  ) => {
    onChange(value);

    if (value === "data_exchange") {
      form.setValue(`buttons.${buttonIndex}.navigate_screen`, undefined, {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });
      return;
    }

    const flowId = toOptionalFormString(
      form.getValues(`buttons.${buttonIndex}.flow_id`)
    );
    if (!flowId) {
      return;
    }

    const screenIds = await loadFlowScreenIds(flowId);
    const currentScreen = form.getValues(
      `buttons.${buttonIndex}.navigate_screen`
    );
    if (
      screenIds.length > 0 &&
      (!currentScreen || !screenIds.includes(currentScreen))
    ) {
      form.setValue(`buttons.${buttonIndex}.navigate_screen`, screenIds[0], {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });
    }
  };

  useEffect(() => {
    if (hasFlowButton) {
      void loadFlows();
    }
  }, [hasFlowButton, loadFlows]);

  useEffect(() => {
    if (!flowScreenIdsToEnsureKey) return;
    for (const flowId of flowScreenIdsToEnsureKey.split("|")) {
      if (!flowScreenOptionsById[flowId]) {
        void loadFlowScreenIds(flowId);
      }
    }
  }, [flowScreenIdsToEnsureKey, flowScreenOptionsById, loadFlowScreenIds]);

  const resetDraftState = () => {
    form.reset(getDefaultValues(template));
    setVariableRenameDraft({});
    setNewFlowName("");
    setUploadedHeaderMedia(null);
    setHeaderMediaUploadError(null);
    setIsHeaderAssetPickerOpen(false);
    setCarouselAssetCardId(null);
  };

  if (hydratedTemplateRef.current !== template) {
    hydratedTemplateRef.current = template;
    resetDraftState();
    headerMediaUploadAbortRef.current?.abort();
    headerMediaUploadAbortRef.current = null;
  }

  // Unsaved edits survive a reload: a deploy makes this tab's submit fail,
  // and reloading to the new version would otherwise empty the editor.
  const draftStorageKey = getTemplateEditorDraftKey({
    workspaceId,
    templateId: dbTemplateId || metaTemplateId,
  });
  // Read once as the editor opens, so the form and notice start from it.
  const [restoredDraft] = useState(() =>
    readRestorableTemplateEditorDraft(
      draftStorageKey,
      getDefaultValues(template)
    )
  );
  // Shown in the footer: toast buttons can't be clicked under a modal dialog.
  // Reopening within this page load just keeps the edits; a draft from before
  // a reload (or another tab) is announced so it can be discarded.
  const [draftNotice, setDraftNotice] = useState<
    "restored" | "staleVersion" | null
  >(restoredDraft && !restoredDraft.fromThisPage ? "restored" : null);
  const draftEditorRef = useRef({
    defaults: (): TemplateFormValues | null => null,
  });
  useEffect(() => {
    draftEditorRef.current = { defaults: () => getDefaultValues(template) };
  });

  const discardDraft = () => {
    clearTemplateEditorDraft(draftStorageKey);
    resetDraftState();
    setDraftNotice(null);
  };

  useEffect(() => {
    if (restoredDraft) {
      form.reset(restoredDraft.values, { keepDefaultValues: true });
    }
  }, [form, restoredDraft]);

  useEffect(() => {
    let timeoutId: number | null = null;
    const persistDraft = () => {
      timeoutId = null;
      const values = form.getValues();
      const defaults = draftEditorRef.current.defaults();
      if (
        !hasTemplateEditorDraftContent(values) ||
        (defaults &&
          snapshotTemplateEditorValues(values) ===
            snapshotTemplateEditorValues(defaults))
      ) {
        clearTemplateEditorDraft(draftStorageKey);
      } else {
        writeTemplateEditorDraft(draftStorageKey, values);
      }
    };
    const subscription = form.watch(() => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(
        persistDraft,
        TEMPLATE_EDITOR_DRAFT_SAVE_DELAY_MS
      );
    });
    return () => {
      subscription.unsubscribe();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        persistDraft();
      }
    };
  }, [draftStorageKey, form]);

  const reloadEditorToLatestVersion = () => {
    const url = new URL(window.location.href);
    for (const [name, value] of Object.entries(reopenSearchParams ?? {})) {
      url.searchParams.set(name, value);
    }
    void reloadToLatestAppVersion(url);
  };

  if (flowsWorkspaceRef.current !== workspaceId) {
    flowsWorkspaceRef.current = workspaceId;
    flowRequestsSeqRef.current += 1;
    flowsLoadPromiseRef.current = null;
    flowScreenLoadPromisesRef.current = {};
    setAvailableFlows([]);
    setFlowsLoaded(false);
    setFlowsLoading(false);
    setFlowsError(null);
    setFlowScreenOptionsById({});
    setFlowScreenErrorsById({});
    setFlowScreenLoadingById({});
    setNewFlowName("");
  }

  const createFlowInline = async (buttonIndex: number) => {
    const parsedFlowName = whatsAppFlowNameSchema.safeParse({
      name: newFlowName,
    });
    if (!parsedFlowName.success) {
      toast.error(getFirstZodIssueMessage(parsedFlowName.error));
      return;
    }
    const { name } = parsedFlowName.data;

    setCreatingFlow(true);
    try {
      const response = await fetch("/api/whatsapp/flows", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId,
          name,
          categories: ["OTHER"],
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || tTemplates("form.createFlowFailed"));
      }

      const parsedResponse = whatsAppFlowCreateResponseSchema.safeParse(data);
      if (!parsedResponse.success) {
        throw new Error(getFirstZodIssueMessage(parsedResponse.error));
      }
      const createdFlow = parsedResponse.data.flow;
      const createdFlowId = createdFlow.id;

      await loadFlows(true);
      setAvailableFlows(prev =>
        prev.some(flow => flow.id === createdFlowId)
          ? prev
          : [
              {
                id: createdFlowId,
                name: createdFlow.name || name,
                status: createdFlow.status,
              },
              ...prev,
            ]
      );
      setFlowsLoaded(true);
      form.setValue(`buttons.${buttonIndex}.flow_id`, createdFlowId, {
        shouldDirty: true,
        shouldValidate: form.formState.isSubmitted,
      });

      const currentAction =
        form.getValues(`buttons.${buttonIndex}.flow_action`) || "navigate";
      if (!form.getValues(`buttons.${buttonIndex}.flow_action`)) {
        form.setValue(`buttons.${buttonIndex}.flow_action`, "navigate", {
          shouldDirty: true,
        });
      }
      if (currentAction === "navigate") {
        const screenIds = await loadFlowScreenIds(createdFlowId, true);
        if (screenIds[0]) {
          form.setValue(
            `buttons.${buttonIndex}.navigate_screen`,
            screenIds[0],
            {
              shouldDirty: true,
              shouldValidate: form.formState.isSubmitted,
            }
          );
        }
      }

      setNewFlowName("");
      toast.success(tTemplates("form.flowCreated", { name }));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : tTemplates("form.createFlowFailed")
      );
    } finally {
      setCreatingFlow(false);
    }
  };

  const applyWhatsAppTextFormat = (
    fieldName: WhatsAppTextFieldName,
    control: WhatsAppFormatControl
  ) => {
    const input = whatsappTextFieldRefs.current[fieldName];
    const currentValue = String(form.getValues(fieldName) || "");
    const selectionStart = input?.selectionStart ?? currentValue.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const selectedText = currentValue.slice(selectionStart, selectionEnd);
    const replacementText = selectedText || "text";
    const nextValue = `${currentValue.slice(0, selectionStart)}${
      control.start
    }${replacementText}${control.end}${currentValue.slice(selectionEnd)}`;
    const nextSelectionStart = selectionStart + control.start.length;
    const nextSelectionEnd = nextSelectionStart + replacementText.length;

    form.setValue(fieldName, nextValue, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: form.formState.isSubmitted,
    });

    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  };

  /**
   * Puts a variable at the cursor, spaced from the words around it. Meta
   * rejects text that starts or ends with a variable, so it goes where the
   * author is writing rather than after the last word.
   */
  const insertTemplateVariable = (
    fieldName: WhatsAppTextFieldName,
    token: string
  ) => {
    const input = whatsappTextFieldRefs.current[fieldName];
    const currentValue = String(form.getValues(fieldName) || "");
    const selectionStart = input?.selectionStart ?? currentValue.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const before = currentValue.slice(0, selectionStart);
    const after = currentValue.slice(selectionEnd);
    const inserted = `${before === "" || /\s$/.test(before) ? "" : " "}${token}${
      after === "" || /^\s/.test(after) ? "" : " "
    }`;
    const caret = before.length + inserted.length;

    form.setValue(fieldName, `${before}${inserted}${after}`, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: form.formState.isSubmitted,
    });

    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };

  const applyVariableRename = (fromKey: string) => {
    const toKey = (variableRenameDraft[fromKey] || "").trim();

    if (!toKey || fromKey === toKey) {
      return;
    }
    if (!isValidVariableName(toKey)) {
      toast.error(tTemplates("form.variableNameError"));
      return;
    }
    if (allVariableKeys.includes(toKey)) {
      toast.error(tTemplates("form.variableDuplicateError"));
      return;
    }

    const currentHeader = form.getValues("headerText") || "";
    const currentBody = form.getValues("bodyText") || "";
    const currentTelegram = form.getValues("telegramText") || "";
    const currentButtons = form.getValues("buttons") || [];

    form.setValue(
      "headerText",
      renameTemplateVariableInText(currentHeader, fromKey, toKey),
      { shouldValidate: form.formState.isSubmitted, shouldDirty: true }
    );
    form.setValue(
      "bodyText",
      renameTemplateVariableInText(currentBody, fromKey, toKey),
      { shouldValidate: form.formState.isSubmitted, shouldDirty: true }
    );
    form.setValue(
      "telegramText",
      renameTemplateVariableInText(currentTelegram, fromKey, toKey),
      { shouldValidate: form.formState.isSubmitted, shouldDirty: true }
    );
    const renameUrlButton = <T extends { type: string; url?: string }>(
      button: T
    ): T =>
      button.type === "URL"
        ? {
            ...button,
            url: renameTemplateVariableInText(button.url || "", fromKey, toKey),
          }
        : button;
    replaceButtonFields(currentButtons.map(renameUrlButton));
    const currentCards = form.getValues("carouselCards") || [];
    if (currentCards.length > 0) {
      replaceCarouselCards(
        currentCards.map(card => ({
          ...card,
          bodyText: renameTemplateVariableInText(
            card.bodyText || "",
            fromKey,
            toKey
          ),
          buttons: (card.buttons ?? []).map(renameUrlButton),
        }))
      );
    }
    const { [fromKey]: renamedExample, ...otherExamples } =
      form.getValues("variableExamples") || {};
    if (renamedExample) {
      form.setValue("variableExamples", {
        ...otherExamples,
        [toKey]: renamedExample,
      });
    }
    if (form.formState.isSubmitted) {
      void form.trigger(["buttons", "carouselCards"]);
    }

    toast.success(
      tTemplates("form.variableRenamed", {
        from: `{{${fromKey}}}`,
        to: `{{${toKey}}}`,
      })
    );
  };

  // Build Telegram data
  const buildTelegramData = (
    values: TemplateFormValues
  ): TelegramTemplateData => {
    const telegramData: TelegramTemplateData = {
      text: values.telegramText || "",
      parseMode:
        values.telegramParseMode === "None"
          ? undefined
          : (values.telegramParseMode as "Markdown" | "HTML"),
    };

    // Inline keyboard buttons
    if (
      values.hasTelegramButtons &&
      values.telegramButtons &&
      values.telegramButtons.length > 0
    ) {
      // Group buttons into rows (for now, one button per row)
      telegramData.inlineKeyboard = values.telegramButtons
        .filter(btn => btn.text.trim().length > 0)
        .map(btn => [
          {
            text: btn.text,
            url: btn.url || undefined,
            callbackData: btn.callbackData || undefined,
          },
        ]);
    }

    return telegramData;
  };

  const onSubmit = async (submittedValues: TemplateFormValues) => {
    const owner = submissionOwnerRef.current;
    if (!owner || owner.pending) return;
    owner.pending = true;
    const ownsPresentation = () => submissionOwnerRef.current === owner;
    const values = isWhatsAppOnly
      ? ({
          ...submittedValues,
          targetPlatform: "whatsapp",
        } satisfies TemplateFormValues)
      : submittedValues;

    setSubmitting(true);
    setDraftNotice(null);
    try {
      const showWhatsAppForSubmit =
        values.targetPlatform === "whatsapp" ||
        values.targetPlatform === "both";
      const whatsappLanguage = showWhatsAppForSubmit
        ? normalizeWhatsAppTemplateLanguageCode(values.language || "en")
        : null;

      if (showWhatsAppForSubmit && !whatsappLanguage) {
        toast.error(tTemplates("form.errors.langRequired"));
        setSubmitting(false);
        return;
      }

      const submittedOptimizationSpec =
        showWhatsAppForSubmit &&
        values.category === "MARKETING" &&
        values.marketingMaxPriceEnabled
          ? buildWhatsAppMarketingMessagesOptimizationSpecFromFormValues(values)
          : undefined;
      const whatsappOptimizationSpec =
        submittedOptimizationSpec ||
        (isEdit && values.category === "MARKETING"
          ? template?.optimization_spec
          : undefined);

      // Build data for each platform as needed
      const whatsappData = showWhatsAppForSubmit
        ? {
            language: whatsappLanguage || "en",
            category: values.category || "UTILITY",
            components: buildWhatsAppTemplateComponentsFromFormValues(values),
            ...(whatsappOptimizationSpec
              ? { optimization_spec: whatsappOptimizationSpec }
              : {}),
          }
        : undefined;

      const telegramData =
        values.targetPlatform === "telegram" || values.targetPlatform === "both"
          ? buildTelegramData(values)
          : undefined;

      let result;
      let metaTemplateWarning: string | undefined;
      if (isEdit) {
        const shouldUpdateWhatsApp =
          values.targetPlatform === "whatsapp" ||
          values.targetPlatform === "both";
        const shouldUpdateUnified = Boolean(dbTemplateId);

        if (shouldUpdateWhatsApp) {
          if (!metaTemplateId) {
            toast.error(tTemplates("form.editDisabledMissingMetaId"));
            setSubmitting(false);
            return;
          }
          if (!canEditMetaTemplate) {
            toast.error(
              metaEditDisabledReason ||
                tTemplates("form.editDisabledStatus", {
                  status: templateStatus,
                })
            );
            setSubmitting(false);
            return;
          }

          const metaUpdatePayload: {
            workspaceId: string;
            templateId: string;
            category?: "MARKETING" | "UTILITY" | "AUTHENTICATION";
            optimization_spec?: NonNullable<
              typeof whatsappData
            >["optimization_spec"];
            components?: NonNullable<typeof whatsappData>["components"];
          } = {
            workspaceId,
            templateId: metaTemplateId,
          };

          const originalValues = getDefaultValues(template);
          const originalComponents =
            buildWhatsAppTemplateComponentsFromFormValues(originalValues);
          const nextComponents = whatsappData?.components || [];
          if (
            !areTemplateEditorValuesEqual(nextComponents, originalComponents)
          ) {
            metaUpdatePayload.components = nextComponents;
          }

          if (
            submittedOptimizationSpec &&
            !areTemplateEditorValuesEqual(
              submittedOptimizationSpec,
              template?.optimization_spec
            )
          ) {
            metaUpdatePayload.optimization_spec = submittedOptimizationSpec;
          }
          const nextCategory = values.category || "UTILITY";
          if (nextCategory !== template?.category) {
            metaUpdatePayload.category = nextCategory;
          }

          const hasMetaChanges =
            metaUpdatePayload.components !== undefined ||
            metaUpdatePayload.category !== undefined ||
            metaUpdatePayload.optimization_spec !== undefined;

          if (hasMetaChanges) {
            result = await updateTemplateAction(metaUpdatePayload);

            if (!result.success) {
              if (ownsPresentation()) toast.error(result.error);
              return;
            }
            metaTemplateWarning = result.data.warning;
          } else {
            result = { success: true as const, data: { success: true } };
          }
        }

        if (shouldUpdateUnified) {
          result = await updateUnifiedTemplateAction({
            workspaceId,
            templateId: dbTemplateId!,
            channel: values.targetPlatform,
            whatsappData,
            telegramData,
          });
        } else if (result?.success) {
          // Keep a success result when only Meta update was needed.
          result = { success: true, data: { success: true } };
        } else if (!result) {
          result = {
            success: false as const,
            error: tTemplates("form.editDisabledMissingDbId"),
          };
        }
      } else {
        // Creating new template - use unified action
        result = await createUnifiedTemplateAction({
          workspaceId,
          name: values.name,
          channel: values.targetPlatform,
          whatsappData,
          telegramData,
        });
      }

      if (!ownsPresentation()) return;
      if (result.success) {
        toast.success(
          isEdit
            ? tTemplates("alerts.updateSuccess")
            : tTemplates("alerts.createSuccess")
        );
        const resultWarning =
          result.data &&
          typeof result.data === "object" &&
          "warning" in result.data &&
          typeof result.data.warning === "string"
            ? result.data.warning
            : undefined;
        const warning = metaTemplateWarning || resultWarning;
        if (warning) {
          toast.warning(warning);
        }
        clearTemplateEditorDraft(draftStorageKey);
        form.reset();
        setVariableRenameDraft({});
        setNewFlowName("");
        setUploadedHeaderMedia(null);
        setHeaderMediaUploadError(null);
        onSuccess();
      } else {
        toast.error(result.error);
      }
    } catch (error) {
      if (unstable_isUnrecognizedActionError(error)) {
        // This tab predates the current deploy, so its server actions are gone.
        writeTemplateEditorDraft(draftStorageKey, form.getValues());
        if (ownsPresentation()) setDraftNotice("staleVersion");
      } else if (ownsPresentation()) {
        toast.error(
          error instanceof Error
            ? error.message
            : tTemplates("alerts.saveFailed")
        );
      }
    } finally {
      if (ownsPresentation()) {
        owner.pending = false;
        setSubmitting(false);
      }
    }
  };

  const handleInvalidSubmit = (errors: unknown) => {
    toast.error(
      getFirstTemplateFormErrorMessage(errors) ||
        tTemplates("alerts.saveFailed")
    );
  };

  const submitTemplate = form.handleSubmit(onSubmit, handleInvalidSubmit);

  const addButton = () => {
    const nextButton = withTemplateButtonClientId(
      { type: "QUICK_REPLY" as const, text: "" },
      "whatsapp"
    );
    const nextButtons = [...(form.getValues("buttons") || []), nextButton];
    const limitValidation =
      templateButtonTypeLimitSchema.safeParse(nextButtons);
    if (!limitValidation.success) {
      toast.error(getFirstZodIssueMessage(limitValidation.error));
      return;
    }
    form.setValue("hasButtons", true, { shouldDirty: true });
    appendButtonField(nextButton, { shouldFocus: false });
    if (form.formState.isSubmitted) {
      void form.trigger("buttons");
    }
  };

  const handleButtonTypeChange = (
    index: number,
    nextType: WhatsAppTemplateButtonFormType
  ) => {
    const currentButtons = form.getValues("buttons") || [];
    const currentButton = currentButtons[index];
    if (!currentButton) return;

    const nextButton = {
      ...currentButton,
      type: nextType,
      text: nextType === "REQUEST_CONTACT_INFO" ? "" : currentButton.text || "",
      url: nextType === "URL" ? currentButton.url : undefined,
      phone_number:
        nextType === "PHONE_NUMBER" ? currentButton.phone_number : undefined,
      flow_id:
        nextType === "FLOW"
          ? toOptionalFormString(currentButton.flow_id)
          : undefined,
      flow_action:
        nextType === "FLOW"
          ? currentButton.flow_action || "navigate"
          : undefined,
      navigate_screen:
        nextType === "FLOW" ? currentButton.navigate_screen : undefined,
      otp_type: nextType === "OTP" ? currentButton.otp_type : undefined,
    };
    const nextButtons = currentButtons.map((button, buttonIndex) =>
      buttonIndex === index ? nextButton : button
    );
    const limitValidation =
      templateButtonTypeLimitSchema.safeParse(nextButtons);
    if (!limitValidation.success) {
      toast.error(getFirstZodIssueMessage(limitValidation.error));
      return;
    }

    if (nextType === "FLOW") {
      void loadFlows();
    }

    updateButtonField(index, nextButton);
    if (form.formState.isSubmitted) {
      void form.trigger(`buttons.${index}`);
    }
  };

  const removeButton = (index: number) => {
    const remaining = (form.getValues("buttons") || []).length - 1;
    removeButtonField(index);
    if (remaining <= 0) {
      form.setValue("hasButtons", false, { shouldDirty: true });
    }
    if (form.formState.isSubmitted) {
      void form.trigger("buttons");
    }
  };

  const toggleOptionalSection = (
    field: "hasHeader" | "hasFooter" | "hasButtons",
    enabled: boolean
  ) => {
    form.setValue(field, enabled, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
    if (field === "hasButtons" && enabled) {
      const currentButtons = form.getValues("buttons") || [];
      if (currentButtons.length === 0) {
        addButton();
      }
    }
  };

  const applyWhatsAppMarketingLayout = (layout: "standard" | "carousel") => {
    if (layout !== "carousel") return;

    const currentCards = form.getValues("carouselCards") || [];
    if (currentCards.length < WHATSAPP_TEMPLATE_LIMITS.CAROUSEL_CARDS_MIN) {
      replaceCarouselCards(createTemplateCarouselDraftCards());
      form.setValue("carouselHeaderFormat", "IMAGE", { shouldDirty: true });
    }
  };

  const addTelegramButton = () => {
    appendTelegramButtonField(
      withTemplateButtonClientId(
        { text: "", url: undefined, callbackData: undefined },
        "telegram"
      ),
      { shouldFocus: false }
    );
    form.setValue("hasTelegramButtons", true, { shouldDirty: true });
    if (form.formState.isSubmitted) {
      void form.trigger("telegramButtons");
    }
  };

  const removeTelegramButton = (index: number) => {
    removeTelegramButtonField(index);
    if (form.formState.isSubmitted) {
      void form.trigger("telegramButtons");
    }
  };

  const missingMetaIdForTarget =
    isEdit &&
    (targetPlatform === "whatsapp" || targetPlatform === "both") &&
    !metaTemplateId;

  const missingDbIdForTarget =
    isEdit &&
    (targetPlatform === "telegram" || targetPlatform === "both") &&
    !dbTemplateId;

  const isSaveDisabled =
    submitting ||
    missingMetaIdForTarget ||
    missingDbIdForTarget ||
    Boolean(metaEditDisabledReason);

  const carouselAssetSelectedUrl =
    carouselCards.find(card => card.clientId === carouselAssetCardId)
      ?.headerMediaExample || "";

  const handleCancel = () => {
    clearTemplateEditorDraft(draftStorageKey);
    resetDraftState();
    onCancel?.();
  };

  return (
    <>
      {isHeaderAssetPickerOpen ? (
        <CreativeAssetPickerDialog
          workspaceId={workspaceId}
          open={isHeaderAssetPickerOpen}
          onOpenChange={setIsHeaderAssetPickerOpen}
          kind={
            headerFormat === "VIDEO"
              ? "video"
              : headerFormat === "IMAGE"
                ? "image"
                : null
          }
          selectedUrls={headerMediaExample ? [headerMediaExample] : []}
          assetFilter={isHeaderAssetSelectable}
          onSelect={handleSelectHeaderAsset}
        />
      ) : null}
      {carouselAssetCardId ? (
        <CreativeAssetPickerDialog
          workspaceId={workspaceId}
          open={Boolean(carouselAssetCardId)}
          onOpenChange={open => {
            if (!open) setCarouselAssetCardId(null);
          }}
          kind={carouselHeaderFormat === "VIDEO" ? "video" : "image"}
          selectedUrls={
            carouselAssetSelectedUrl ? [carouselAssetSelectedUrl] : []
          }
          assetFilter={isCarouselAssetSelectable}
          onSelect={handleSelectCarouselCardAsset}
        />
      ) : null}
      <div
        className={cn(
          "flex flex-col rounded-xl border bg-background",
          useModalLayout ? "h-full min-h-0" : "h-fit",
          className
        )}
      >
        <div
          className={cn("border-b px-4", useModalLayout ? "py-2.5" : "py-3")}
        >
          <h3
            className={cn(
              "font-semibold tracking-tight",
              useModalLayout ? "text-sm" : "text-base"
            )}
          >
            {title ||
              (isEdit ? tTemplates("form.edit") : tTemplates("form.createNew"))}
          </h3>
          {!useModalLayout ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {isEdit ? tTemplates("form.update") : tTemplates("form.create")}
            </p>
          ) : null}
        </div>

        <Form {...form}>
          <form
            noValidate
            onSubmit={submitTemplate}
            className={cn(
              "flex min-h-0 flex-col",
              useModalLayout && "h-full flex-1"
            )}
          >
            <div
              className={cn(
                useModalLayout
                  ? "grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]"
                  : "px-4 pb-4 pt-4"
              )}
            >
              {useModalLayout ? (
                <div className="min-h-0 overflow-y-auto border-b bg-muted/30 px-4 py-4 lg:border-b-0 lg:border-r">
                  <TemplatePhonePreview
                    template={livePreviewTemplate}
                    mode="modal"
                    emptyBodyText={tTemplates("form.previewEmpty")}
                  />
                </div>
              ) : null}

              <FieldGroup
                className={cn(
                  "gap-5",
                  useModalLayout && "min-h-0 gap-4 overflow-y-auto px-4 py-4"
                )}
              >
                <TemplateFormSection title={tTemplates("form.basicInfo")}>
                  <div className="space-y-3">
                    {isWhatsAppOnly ? null : (
                      <FormField
                        control={form.control}
                        name="targetPlatform"
                        render={({ field }) => (
                          <FormItem className={TEMPLATE_FORM_FIELD_ITEM_CLASS}>
                            <FormLabel
                              className={cn(useModalLayout && "sr-only")}
                            >
                              {tTemplates("form.platform")}
                            </FormLabel>
                            <FormControl>
                              <Tabs
                                value={field.value}
                                onValueChange={field.onChange}
                                className="w-full"
                              >
                                <TabsList
                                  className={cn(
                                    "grid w-full grid-cols-3",
                                    useModalLayout && "h-9"
                                  )}
                                >
                                  <TabsTrigger value="whatsapp">
                                    <Image
                                      src={WhatsAppIcon}
                                      alt="WhatsApp"
                                      width={16}
                                      height={16}
                                    />
                                    WhatsApp
                                  </TabsTrigger>
                                  <TabsTrigger value="telegram">
                                    <Image
                                      src={TelegramIcon}
                                      alt="Telegram"
                                      width={16}
                                      height={16}
                                    />
                                    Telegram
                                  </TabsTrigger>
                                  <TabsTrigger value="both">
                                    {tTemplates("form.both")}
                                  </TabsTrigger>
                                </TabsList>
                              </Tabs>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}

                    <FormField
                      control={form.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem className={TEMPLATE_FORM_FIELD_ITEM_CLASS}>
                          <FormLabel>{tTemplates("form.name")}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              onChange={event => {
                                const input = event.currentTarget;
                                const next = normalizeTemplateNameInput(
                                  input.value
                                );
                                if (next !== input.value) {
                                  // Same length, so the caret keeps its place;
                                  // React then finds nothing to rewrite.
                                  const { selectionStart, selectionEnd } =
                                    input;
                                  input.value = next;
                                  input.setSelectionRange(
                                    selectionStart,
                                    selectionEnd
                                  );
                                }
                                field.onChange(next);
                              }}
                              placeholder="order_confirmation"
                              autoComplete="off"
                              spellCheck={false}
                              disabled={isEdit}
                            />
                          </FormControl>
                          {!isEdit ? (
                            <FormDescription className="text-xs">
                              {tTemplates("form.nameValidation")}
                            </FormDescription>
                          ) : null}
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {showWhatsApp && (
                      <>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <FormField
                            control={form.control}
                            name="language"
                            render={({ field }) => (
                              <FormItem
                                className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                              >
                                <FormLabel>{tTemplates("form.lang")}</FormLabel>
                                <FormControl>
                                  <TemplateLanguageSelect
                                    ref={field.ref}
                                    value={field.value || ""}
                                    onChange={field.onChange}
                                    onBlur={field.onBlur}
                                    disabled={isEdit}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          <FormField
                            control={form.control}
                            name="category"
                            render={({ field }) => (
                              <FormItem
                                className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                              >
                                <FormLabel>
                                  {tTemplates("form.category")}
                                </FormLabel>
                                <Select {...bindTemplateSelectField(field)}>
                                  <TemplateSelectTrigger />
                                  <SelectContent>
                                    {(
                                      Object.keys(
                                        TEMPLATE_CATEGORY_METADATA
                                      ) as Array<
                                        keyof typeof TEMPLATE_CATEGORY_METADATA
                                      >
                                    ).map(key => (
                                      <SelectItem key={key} value={key}>
                                        {tTemplates(`categories.${key}`)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <FormDescription className="text-xs">
                                  {tTemplates(
                                    `form.categoryHints.${selectedCategory}`
                                  )}
                                </FormDescription>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </div>

                        {selectedCategory === "MARKETING" && (
                          <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                            <FormField
                              control={form.control}
                              name="marketingMaxPriceEnabled"
                              render={({ field }) => (
                                <FormItem className="flex items-center justify-between gap-3 space-y-0">
                                  <FormLabel>
                                    {tTemplates("form.marketingMaxPrice")}
                                  </FormLabel>
                                  <FormControl>
                                    <Switch
                                      checked={Boolean(field.value)}
                                      onCheckedChange={field.onChange}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />

                            {marketingMaxPriceEnabled && (
                              <FormField
                                control={form.control}
                                name="marketingMaxPriceBidAmount"
                                render={({ field }) => (
                                  <FormItem
                                    className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                                  >
                                    <FormLabel>
                                      {tTemplates(
                                        "form.marketingMaxPriceBidAmount"
                                      )}
                                    </FormLabel>
                                    <FormControl>
                                      <Input
                                        type="number"
                                        min={1}
                                        step={1}
                                        inputMode="numeric"
                                        value={field.value ?? ""}
                                        onChange={event =>
                                          field.onChange(event.target.value)
                                        }
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </TemplateFormSection>

                {showWhatsApp && selectedCategory === "MARKETING" && (
                  <TemplateFormSection title={tTemplates("form.layout")}>
                    <FormField
                      control={form.control}
                      name="hasCarousel"
                      render={({ field }) => (
                        <FormItem className="space-y-2" onBlur={field.onBlur}>
                          <TemplateWhatsAppLayoutPicker
                            value={getWhatsAppMarketingLayout(
                              Boolean(field.value)
                            )}
                            showHiddenStandardNote={standardLayoutHasExclusiveSections(
                              {
                                hasHeader,
                                hasFooter,
                                hasButtons,
                              }
                            )}
                            showHiddenCarouselNote={carouselCardsHaveUserContent(
                              carouselCards
                            )}
                            onChange={nextLayout => {
                              applyWhatsAppMarketingLayout(nextLayout);
                              field.onChange(nextLayout === "carousel");
                            }}
                          />
                        </FormItem>
                      )}
                    />
                  </TemplateFormSection>
                )}

                {(targetPlatform === "whatsapp" || targetPlatform === "both") &&
                  selectedCategory !== "AUTHENTICATION" &&
                  !hasCarousel && (
                    <TemplateFormSection
                      title={tTemplates("form.header")}
                      action={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={TEMPLATE_FORM_OPTIONAL_ACTION_CLASS}
                          onClick={() =>
                            toggleOptionalSection("hasHeader", !hasHeader)
                          }
                        >
                          {hasHeader
                            ? tTemplates("form.removeHeader")
                            : tTemplates("form.addHeader")}
                        </Button>
                      }
                    >
                      {hasHeader && (
                        <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                          <FormField
                            control={form.control}
                            name="headerFormat"
                            render={({ field }) => (
                              <FormItem
                                className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                              >
                                <FormLabel>
                                  {tTemplates("form.format")}
                                </FormLabel>
                                <Select {...bindTemplateSelectField(field)}>
                                  <TemplateSelectTrigger />
                                  <SelectContent>
                                    {HEADER_FORMAT_OPTIONS.map(
                                      ([value, labelKey]) => (
                                        <SelectItem key={value} value={value}>
                                          {tTemplates(labelKey)}
                                        </SelectItem>
                                      )
                                    )}
                                    {headerFormat === "LOCATION" && (
                                      <SelectItem value="LOCATION">
                                        {tTemplates("form.location")}
                                      </SelectItem>
                                    )}
                                  </SelectContent>
                                </Select>
                                <FormMessage />
                              </FormItem>
                            )}
                          />

                          {hasMediaHeader && (
                            <FormField
                              control={form.control}
                              name="headerMediaExample"
                              render={({ field }) => (
                                <FormItem
                                  className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                                >
                                  <FormLabel>
                                    {tTemplates("form.mediaExample")}
                                  </FormLabel>
                                  <FormControl>
                                    <div className="space-y-3">
                                      <Input
                                        {...field}
                                        placeholder={tTemplates(
                                          "form.mediaExamplePlaceholder"
                                        )}
                                      />
                                      <div
                                        data-testid="template-header-media-dropzone"
                                        className={cn(
                                          "flex flex-col gap-3 rounded-lg border border-dashed bg-background p-3 transition-colors sm:flex-row sm:items-center sm:justify-between",
                                          useModalLayout &&
                                            "gap-2 rounded-md p-2",
                                          headerMediaDragActive
                                            ? "border-primary bg-primary/5"
                                            : "border-border"
                                        )}
                                        onDragOver={handleHeaderMediaDragOver}
                                        onDragLeave={handleHeaderMediaDragLeave}
                                        onDrop={handleHeaderMediaDrop}
                                      >
                                        <input
                                          ref={headerMediaInputRef}
                                          type="file"
                                          className="sr-only"
                                          aria-label={tTemplates(
                                            "form.attachMedia"
                                          )}
                                          accept={
                                            isWhatsAppTemplateMediaHeaderFormat(
                                              headerFormat
                                            )
                                              ? WHATSAPP_TEMPLATE_HEADER_MEDIA_ACCEPT_BY_FORMAT[
                                                  headerFormat
                                                ]
                                              : undefined
                                          }
                                          disabled={headerMediaUploading}
                                          onChange={
                                            handleHeaderMediaInputChange
                                          }
                                        />
                                        <div className="flex min-w-0 items-start gap-3">
                                          <div
                                            className={cn(
                                              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
                                              useModalLayout && "size-7"
                                            )}
                                          >
                                            {headerMediaUploading ? (
                                              <Loader2 className="size-4 animate-spin" />
                                            ) : (
                                              <Upload className="size-4" />
                                            )}
                                          </div>
                                          <div className="min-w-0 space-y-1">
                                            <p className="text-sm font-medium">
                                              {headerMediaUploading
                                                ? tTemplates(
                                                    "form.mediaUploading"
                                                  )
                                                : tTemplates(
                                                    "form.dropMediaHere"
                                                  )}
                                            </p>
                                            {!useModalLayout ? (
                                              <p className="text-xs text-muted-foreground">
                                                {tTemplates(
                                                  "form.mediaDropzoneDescription"
                                                )}
                                              </p>
                                            ) : null}
                                            {headerFormat === "VIDEO" && (
                                              <p className="text-xs text-muted-foreground">
                                                {tTemplates(
                                                  "form.templateVideoRequirement"
                                                )}
                                              </p>
                                            )}
                                            {uploadedHeaderMedia && (
                                              <p className="truncate text-xs text-muted-foreground">
                                                {tTemplates(
                                                  "form.uploadedMedia",
                                                  {
                                                    fileName:
                                                      uploadedHeaderMedia.fileName,
                                                  }
                                                )}
                                              </p>
                                            )}
                                            {headerMediaUploadError && (
                                              <p className="text-xs text-destructive">
                                                {headerMediaUploadError}
                                              </p>
                                            )}
                                          </div>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                          {uploadedHeaderMedia && (
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="sm"
                                              className="h-8 px-2"
                                              disabled={headerMediaUploading}
                                              aria-label={tTemplates(
                                                "form.removeMedia"
                                              )}
                                              onClick={clearUploadedHeaderMedia}
                                            >
                                              <X className="size-4" />
                                            </Button>
                                          )}
                                          {(headerFormat === "IMAGE" ||
                                            headerFormat === "VIDEO") && (
                                            <Button
                                              type="button"
                                              variant="outline"
                                              size="sm"
                                              className="h-8"
                                              disabled={headerMediaUploading}
                                              onClick={() =>
                                                setIsHeaderAssetPickerOpen(true)
                                              }
                                            >
                                              <Images className="size-4" />
                                              <span
                                                className={cn(
                                                  useModalLayout && "sr-only"
                                                )}
                                              >
                                                {tTemplates("form.chooseAsset")}
                                              </span>
                                            </Button>
                                          )}
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="h-8"
                                            disabled={headerMediaUploading}
                                            onClick={() =>
                                              headerMediaInputRef.current?.click()
                                            }
                                          >
                                            <Paperclip className="size-4" />
                                            <span
                                              className={cn(
                                                useModalLayout && "sr-only"
                                              )}
                                            >
                                              {tTemplates("form.attachMedia")}
                                            </span>
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                  </FormControl>
                                  {!useModalLayout ? (
                                    <p className="text-xs text-muted-foreground">
                                      {tTemplates("form.mediaRequirement")}
                                    </p>
                                  ) : null}
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                          )}

                          {headerFormat === "TEXT" && (
                            <FormField
                              control={form.control}
                              name="headerText"
                              render={({ field, fieldState }) => {
                                const {
                                  ref: headerFieldRef,
                                  ...headerFieldProps
                                } = field;
                                const charCount = (field.value || "").length;
                                const vars = headerVars;
                                const nextVar = getNextVariableIndex(
                                  field.value || ""
                                );
                                const nextVarToken = `{{${nextVar}}}`;
                                // Meta takes one variable in a text header.
                                const canInsert =
                                  (field.value || "").trim().length > 0 &&
                                  vars.length === 0;
                                return (
                                  <FormItem>
                                    <FormLabel>
                                      {tTemplates("form.headerText")}
                                    </FormLabel>
                                    <FormControl>
                                      <Input
                                        {...headerFieldProps}
                                        ref={node => {
                                          headerFieldRef(node);
                                          whatsappTextFieldRefs.current.headerText =
                                            node;
                                        }}
                                        maxLength={60}
                                        placeholder={tTemplates(
                                          "form.headerTextPlaceholder"
                                        )}
                                        className={cn(
                                          fieldState.error &&
                                            "border-destructive"
                                        )}
                                      />
                                    </FormControl>
                                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                      <div className="flex flex-wrap items-center gap-2">
                                        {vars.length > 0 && (
                                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                                            {vars
                                              .map(v => `{{${v}}}`)
                                              .join(", ")}
                                          </span>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <Button
                                          type="button"
                                          variant="outline"
                                          size="sm"
                                          className="h-6 px-2 text-[10px]"
                                          disabled={!canInsert}
                                          onClick={() =>
                                            insertTemplateVariable(
                                              "headerText",
                                              nextVarToken
                                            )
                                          }
                                        >
                                          {tTemplates("form.insertVariable", {
                                            var: nextVarToken,
                                          })}
                                        </Button>
                                        <span
                                          className={
                                            charCount > 55
                                              ? "text-destructive"
                                              : ""
                                          }
                                        >
                                          {charCount}/60
                                        </span>
                                      </div>
                                    </div>
                                    {hasTemplateHeaderFormattingMarkers(
                                      field.value || ""
                                    ) ? (
                                      <p className="text-xs text-amber-700 dark:text-amber-400">
                                        {tTemplates(
                                          "form.headerFormattingWarning"
                                        )}
                                      </p>
                                    ) : null}
                                    <FormMessage />
                                  </FormItem>
                                );
                              }}
                            />
                          )}
                        </div>
                      )}
                    </TemplateFormSection>
                  )}

                {showWhatsApp && selectedCategory === "AUTHENTICATION" && (
                  <TemplateFormSection title={tTemplates("form.authPreset")}>
                    <p className="text-sm text-muted-foreground">
                      {tTemplates("form.authPresetHint")}
                    </p>
                    <FormField
                      control={form.control}
                      name="authSecurityRecommendation"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between gap-4 rounded-lg border p-3">
                          <FormLabel>
                            {tTemplates("form.authSecurityRecommendation")}
                          </FormLabel>
                          <FormControl>
                            <Switch
                              checked={field.value !== false}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="authCodeExpirationMinutes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tTemplates("form.authExpiry")}</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type="number"
                              min={1}
                              max={90}
                              step={1}
                              value={field.value ?? ""}
                              onChange={event =>
                                field.onChange(
                                  event.target.value === ""
                                    ? ""
                                    : Number(event.target.value)
                                )
                              }
                            />
                          </FormControl>
                          <FormDescription>
                            {tTemplates("form.authExpiryHint")}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TemplateFormSection>
                )}

                {(targetPlatform === "whatsapp" || targetPlatform === "both") &&
                  selectedCategory !== "AUTHENTICATION" && (
                    <section className="space-y-3">
                      <FormField
                        control={form.control}
                        name="bodyText"
                        render={({ field, fieldState }) => {
                          const { ref: bodyFieldRef, ...bodyFieldProps } =
                            field;
                          const vars = bodyVars;
                          const charCount = (field.value || "").length;
                          const nextVar = getNextVariableIndex(
                            field.value || ""
                          );
                          const nextVarToken = `{{${nextVar}}}`;
                          const canInsert =
                            (field.value || "").trim().length > 0;
                          return (
                            <FormItem
                              className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                            >
                              <div className="flex items-center gap-3">
                                <FormLabel className="shrink-0 gap-1.5">
                                  {tTemplates("form.bodyText")}{" "}
                                  <span className="text-xs font-normal text-muted-foreground">
                                    *{tTemplates("form.required")}
                                  </span>
                                </FormLabel>
                                <Separator className="min-w-8 flex-1" />
                                <TooltipProvider>
                                  <div
                                    className="flex shrink-0 items-center gap-0.5"
                                    aria-label={tTemplates(
                                      "form.formatToolbar"
                                    )}
                                  >
                                    {WHATSAPP_FORMAT_CONTROLS.map(control => {
                                      const Icon = control.icon;
                                      const label = tTemplates(
                                        control.labelKey
                                      );
                                      return (
                                        <Tooltip key={control.key}>
                                          <TooltipTrigger asChild>
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="icon-xs"
                                              className="text-muted-foreground"
                                              aria-label={label}
                                              onClick={() =>
                                                applyWhatsAppTextFormat(
                                                  "bodyText",
                                                  control
                                                )
                                              }
                                            >
                                              <Icon
                                                className="h-3.5 w-3.5"
                                                aria-hidden
                                              />
                                            </Button>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            {label}
                                          </TooltipContent>
                                        </Tooltip>
                                      );
                                    })}
                                  </div>
                                </TooltipProvider>
                              </div>
                              <FormControl>
                                <Textarea
                                  {...bodyFieldProps}
                                  ref={node => {
                                    bodyFieldRef(node);
                                    whatsappTextFieldRefs.current.bodyText =
                                      node;
                                  }}
                                  rows={useModalLayout ? 4 : 6}
                                  maxLength={1024}
                                  placeholder={tTemplates(
                                    "form.bodyPlaceholder",
                                    WHATSAPP_TEMPLATE_EXAMPLE_VARS
                                  )}
                                  className={cn(
                                    useModalLayout && "min-h-28",
                                    fieldState.error && "border-destructive"
                                  )}
                                />
                              </FormControl>
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                <div className="flex flex-wrap items-center gap-2">
                                  {vars.length > 0 && (
                                    <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                                      {vars.map(v => `{{${v}}}`).join(", ")}
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="xs"
                                    disabled={!canInsert}
                                    onClick={() =>
                                      insertTemplateVariable(
                                        "bodyText",
                                        nextVarToken
                                      )
                                    }
                                  >
                                    {tTemplates("form.insertVariable", {
                                      var: nextVarToken,
                                    })}
                                  </Button>
                                  <span
                                    className={
                                      charCount > 1000 ? "text-destructive" : ""
                                    }
                                  >
                                    {charCount}/1024
                                  </span>
                                </div>
                              </div>
                              <FormMessage />
                            </FormItem>
                          );
                        }}
                      />
                    </section>
                  )}

                {showWhatsApp &&
                  selectedCategory === "MARKETING" &&
                  hasCarousel && (
                    <TemplateFormSection title={tTemplates("form.carousel")}>
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {tTemplates("form.carouselHint")}
                        </p>
                        <TemplateCarouselFields
                          fieldArray={carouselFieldArray}
                          disabled={!canEditMetaTemplate}
                          onUploadMedia={uploadCarouselCardMedia}
                          onPickAsset={setCarouselAssetCardId}
                        />
                      </div>
                    </TemplateFormSection>
                  )}

                {(targetPlatform === "whatsapp" || targetPlatform === "both") &&
                  selectedCategory !== "AUTHENTICATION" &&
                  !hasCarousel && (
                    <TemplateFormSection
                      title={tTemplates("form.footer")}
                      action={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={TEMPLATE_FORM_OPTIONAL_ACTION_CLASS}
                          onClick={() =>
                            toggleOptionalSection("hasFooter", !hasFooter)
                          }
                        >
                          {hasFooter
                            ? tTemplates("form.removeFooter")
                            : tTemplates("form.addFooter")}
                        </Button>
                      }
                    >
                      {hasFooter ? (
                        <FormField
                          control={form.control}
                          name="footerText"
                          render={({ field }) => (
                            <FormItem
                              className={TEMPLATE_FORM_FIELD_ITEM_CLASS}
                            >
                              <FormLabel>
                                {tTemplates("form.footerText")}
                              </FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  maxLength={60}
                                  placeholder={tTemplates(
                                    "form.footerPlaceholder"
                                  )}
                                />
                              </FormControl>
                              <div className="flex justify-end text-xs text-muted-foreground">
                                <span
                                  className={
                                    (field.value || "").length > 55
                                      ? "text-destructive"
                                      : ""
                                  }
                                >
                                  {(field.value || "").length}/60
                                </span>
                              </div>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      ) : null}
                    </TemplateFormSection>
                  )}

                {(targetPlatform === "whatsapp" || targetPlatform === "both") &&
                  selectedCategory !== "AUTHENTICATION" &&
                  !hasCarousel && (
                    <TemplateFormSection
                      title={tTemplates("form.buttons")}
                      action={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={TEMPLATE_FORM_OPTIONAL_ACTION_CLASS}
                          onClick={() =>
                            toggleOptionalSection("hasButtons", !hasButtons)
                          }
                        >
                          {hasButtons
                            ? tTemplates("form.removeButtons")
                            : tTemplates("form.addButtons")}
                        </Button>
                      }
                    >
                      {hasButtons ? (
                        <div className="space-y-3">
                          {buttonFields.map((field, index) => {
                            const button = buttons[index] || field;
                            return (
                              <div
                                key={field.id}
                                className="space-y-3 rounded-lg border bg-muted/20 p-3"
                              >
                                <div className="flex items-center gap-2">
                                  <Label className="text-sm font-medium">
                                    {tTemplates("form.button")} {index + 1}
                                  </Label>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="ml-auto text-muted-foreground"
                                    aria-label={tTemplates("form.removeButton")}
                                    onClick={() => removeButton(index)}
                                  >
                                    <Trash2 />
                                  </Button>
                                </div>

                                <div
                                  className={cn(
                                    "grid gap-3",
                                    button.type === "REQUEST_CONTACT_INFO"
                                      ? "grid-cols-1"
                                      : "sm:grid-cols-2"
                                  )}
                                >
                                  <FormField
                                    control={form.control}
                                    name={`buttons.${index}.type`}
                                    render={({ field }) => (
                                      <FormItem
                                        className={
                                          TEMPLATE_FORM_FIELD_ITEM_CLASS
                                        }
                                      >
                                        <FormLabel>
                                          {tTemplates("form.type")}
                                        </FormLabel>
                                        <Select
                                          value={field.value}
                                          onValueChange={value =>
                                            handleButtonTypeChange(
                                              index,
                                              value as WhatsAppTemplateButtonFormType
                                            )
                                          }
                                          onOpenChange={open => {
                                            if (!open) field.onBlur();
                                          }}
                                        >
                                          <TemplateSelectTrigger />
                                          <SelectContent>
                                            {BUTTON_TYPE_OPTIONS.map(
                                              ([value, labelKey]) => (
                                                <SelectItem
                                                  key={value}
                                                  value={value}
                                                >
                                                  {tTemplates(labelKey)}
                                                </SelectItem>
                                              )
                                            )}
                                          </SelectContent>
                                        </Select>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />

                                  {button.type === "REQUEST_CONTACT_INFO" ? (
                                    <div className="rounded-md bg-background/70 px-3 py-2 text-sm text-muted-foreground sm:col-span-2">
                                      {tTemplates(
                                        "form.requestContactInfoHelp"
                                      )}
                                    </div>
                                  ) : (
                                    <FormField
                                      control={form.control}
                                      name={`buttons.${index}.text`}
                                      render={({ field }) => (
                                        <FormItem
                                          className={
                                            TEMPLATE_FORM_FIELD_ITEM_CLASS
                                          }
                                        >
                                          <FormLabel>
                                            {tTemplates("form.buttonText")}
                                          </FormLabel>
                                          <FormControl>
                                            <Input
                                              {...field}
                                              maxLength={
                                                WHATSAPP_TEMPLATE_LIMITS.BUTTON_TEXT_MAX_LENGTH
                                              }
                                              placeholder={tTemplates(
                                                "form.buttonTextPlaceholder"
                                              )}
                                            />
                                          </FormControl>
                                          <FormMessage />
                                        </FormItem>
                                      )}
                                    />
                                  )}
                                </div>

                                {button.type === "URL" && (
                                  <FormField
                                    control={form.control}
                                    name={`buttons.${index}.url`}
                                    render={({ field }) => (
                                      <FormItem
                                        className={
                                          TEMPLATE_FORM_FIELD_ITEM_CLASS
                                        }
                                      >
                                        <FormLabel>
                                          {tTemplates("form.url")}
                                        </FormLabel>
                                        <FormControl>
                                          <Input
                                            {...field}
                                            value={field.value ?? ""}
                                            type="url"
                                            placeholder="https://example.com"
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />
                                )}

                                {button.type === "QUICK_REPLY" ||
                                button.type === "URL" ? (
                                  <p className="text-xs leading-relaxed text-muted-foreground">
                                    {tTemplates(
                                      button.type === "URL"
                                        ? "form.urlButtonHint"
                                        : "form.replyButtonHint"
                                    )}
                                  </p>
                                ) : null}

                                {button.type === "PHONE_NUMBER" && (
                                  <FormField
                                    control={form.control}
                                    name={`buttons.${index}.phone_number`}
                                    render={({ field }) => (
                                      <FormItem
                                        className={
                                          TEMPLATE_FORM_FIELD_ITEM_CLASS
                                        }
                                      >
                                        <FormLabel>
                                          {tTemplates("form.phoneNumber")}
                                        </FormLabel>
                                        <FormControl>
                                          <Input
                                            {...field}
                                            value={field.value ?? ""}
                                            type="tel"
                                            placeholder="+1234567890"
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />
                                )}

                                {button.type === "FLOW" &&
                                  (() => {
                                    const selectedFlowId =
                                      toOptionalFormString(button.flow_id) ||
                                      "";
                                    const screenOptions = selectedFlowId
                                      ? flowScreenOptionsById[selectedFlowId] ||
                                        []
                                      : [];
                                    const screenError = selectedFlowId
                                      ? flowScreenErrorsById[selectedFlowId]
                                      : null;
                                    const screensLoading = selectedFlowId
                                      ? Boolean(
                                          flowScreenLoadingById[selectedFlowId]
                                        )
                                      : false;
                                    const flowHealth = selectedFlowId
                                      ? evaluateEditorFlowButton({
                                          text: button.text,
                                          flowId: selectedFlowId,
                                          flowAction: button.flow_action,
                                          navigateScreen:
                                            button.navigate_screen,
                                          flow: availableFlows.find(
                                            flow => flow.id === selectedFlowId
                                          ),
                                          screenIds: screenOptions,
                                        })
                                      : null;

                                    return (
                                      <div className="space-y-3 rounded-lg border bg-background/70 p-3">
                                        <div className="flex items-center gap-2">
                                          <Label className="text-sm font-medium">
                                            {tTemplates("form.whatsappFlow")}
                                          </Label>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            className="ml-auto text-muted-foreground"
                                            aria-label={tTemplates(
                                              "form.selectFlow"
                                            )}
                                            onClick={() => void loadFlows(true)}
                                            disabled={flowsLoading}
                                          >
                                            {flowsLoading ? (
                                              <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                              <RefreshCw className="h-4 w-4" />
                                            )}
                                          </Button>
                                        </div>

                                        {flowsError && (
                                          <p className="text-xs text-destructive">
                                            {flowsError}
                                          </p>
                                        )}

                                        <FormField
                                          control={form.control}
                                          name={`buttons.${index}.flow_id`}
                                          render={({ field }) => (
                                            <FormItem>
                                              <FormLabel>
                                                {tTemplates("form.selectFlow")}
                                              </FormLabel>
                                              <Select
                                                value={
                                                  toOptionalFormString(
                                                    field.value
                                                  ) || ""
                                                }
                                                disabled={
                                                  flowsLoading &&
                                                  availableFlows.length === 0
                                                }
                                                onValueChange={value => {
                                                  void handleFlowSelect(
                                                    index,
                                                    value
                                                  );
                                                }}
                                                onOpenChange={open => {
                                                  if (!open) field.onBlur();
                                                }}
                                              >
                                                <TemplateSelectTrigger
                                                  placeholder={tTemplates(
                                                    "form.selectFlowPlaceholder"
                                                  )}
                                                />
                                                <SelectContent>
                                                  {availableFlows.map(flow => (
                                                    <SelectItem
                                                      key={flow.id}
                                                      value={flow.id}
                                                    >
                                                      <span className="flex min-w-0 items-center gap-2">
                                                        <span className="truncate">
                                                          {flow.name || flow.id}
                                                        </span>
                                                        {flow.status &&
                                                        flow.status !==
                                                          "PUBLISHED" ? (
                                                          <Badge
                                                            variant={getWhatsAppFlowStatusVariant(
                                                              flow.status
                                                            )}
                                                            className="shrink-0 text-[10px]"
                                                          >
                                                            {flow.status}
                                                          </Badge>
                                                        ) : null}
                                                      </span>
                                                    </SelectItem>
                                                  ))}
                                                </SelectContent>
                                              </Select>
                                              <FormMessage />
                                            </FormItem>
                                          )}
                                        />

                                        <div className="space-y-2">
                                          <Label>
                                            {tTemplates("form.createFlow")}
                                          </Label>
                                          <div className="flex flex-col gap-2 sm:flex-row">
                                            <Input
                                              value={newFlowName}
                                              onChange={event =>
                                                setNewFlowName(
                                                  event.target.value
                                                )
                                              }
                                              placeholder={tTemplates(
                                                "form.createFlowPlaceholder"
                                              )}
                                            />
                                            <Button
                                              type="button"
                                              variant="secondary"
                                              size="sm"
                                              className="shrink-0"
                                              onClick={() =>
                                                void createFlowInline(index)
                                              }
                                              disabled={creatingFlow}
                                            >
                                              {creatingFlow && (
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                              )}
                                              {tTemplates(
                                                "form.createFlowInline"
                                              )}
                                            </Button>
                                          </div>
                                        </div>

                                        <FormField
                                          control={form.control}
                                          name={`buttons.${index}.flow_action`}
                                          render={({ field }) => (
                                            <FormItem>
                                              <FormLabel>
                                                {tTemplates("form.flowAction")}
                                              </FormLabel>
                                              <Select
                                                value={
                                                  field.value || "navigate"
                                                }
                                                onValueChange={value => {
                                                  void handleFlowActionChange(
                                                    index,
                                                    value as
                                                      | "navigate"
                                                      | "data_exchange",
                                                    field.onChange
                                                  );
                                                }}
                                                onOpenChange={open => {
                                                  if (!open) field.onBlur();
                                                }}
                                              >
                                                <TemplateSelectTrigger />
                                                <SelectContent>
                                                  {FLOW_ACTION_OPTIONS.map(
                                                    ([value, labelKey]) => (
                                                      <SelectItem
                                                        key={value}
                                                        value={value}
                                                      >
                                                        {tTemplates(labelKey)}
                                                      </SelectItem>
                                                    )
                                                  )}
                                                </SelectContent>
                                              </Select>
                                              <FormMessage />
                                            </FormItem>
                                          )}
                                        />

                                        {(button.flow_action || "navigate") ===
                                          "navigate" && (
                                          <FormField
                                            control={form.control}
                                            name={`buttons.${index}.navigate_screen`}
                                            render={({ field }) => (
                                              <FormItem>
                                                <FormLabel>
                                                  {tTemplates(
                                                    "form.flowNavigateScreen"
                                                  )}
                                                </FormLabel>
                                                <FormControl>
                                                  {screenOptions.length > 0 ? (
                                                    <Select
                                                      value={
                                                        field.value || undefined
                                                      }
                                                      onValueChange={
                                                        field.onChange
                                                      }
                                                      onOpenChange={open => {
                                                        if (!open)
                                                          field.onBlur();
                                                      }}
                                                    >
                                                      <SelectTrigger
                                                        className={
                                                          TEMPLATE_FORM_SELECT_TRIGGER_CLASS
                                                        }
                                                      >
                                                        <SelectValue
                                                          placeholder={tTemplates(
                                                            "form.flowNavigateScreenPlaceholder"
                                                          )}
                                                        />
                                                      </SelectTrigger>
                                                      <SelectContent>
                                                        {field.value &&
                                                        !screenOptions.includes(
                                                          field.value
                                                        ) ? (
                                                          // Keep a saved screen the Flow lost visible instead of a blank picker.
                                                          <SelectItem
                                                            value={field.value}
                                                            disabled
                                                          >
                                                            {tTemplates(
                                                              "flowHealth.missingScreenOption",
                                                              {
                                                                screen:
                                                                  field.value,
                                                              }
                                                            )}
                                                          </SelectItem>
                                                        ) : null}
                                                        {screenOptions.map(
                                                          screenId => (
                                                            <SelectItem
                                                              key={screenId}
                                                              value={screenId}
                                                            >
                                                              {screenId}
                                                            </SelectItem>
                                                          )
                                                        )}
                                                      </SelectContent>
                                                    </Select>
                                                  ) : (
                                                    <Input
                                                      {...field}
                                                      placeholder={tTemplates(
                                                        "form.flowNavigateScreenPlaceholder"
                                                      )}
                                                    />
                                                  )}
                                                </FormControl>
                                                {selectedFlowId && (
                                                  <div className="flex items-center justify-between gap-2 text-xs">
                                                    <span
                                                      className={
                                                        screenError
                                                          ? "text-destructive"
                                                          : "text-muted-foreground"
                                                      }
                                                    >
                                                      {screensLoading
                                                        ? tTemplates(
                                                            "form.loadingFlowScreens"
                                                          )
                                                        : screenError ||
                                                          tTemplates(
                                                            "form.flowNavigateScreenHelp"
                                                          )}
                                                    </span>
                                                    <Button
                                                      type="button"
                                                      variant="ghost"
                                                      size="sm"
                                                      className="h-7 px-2 text-xs"
                                                      onClick={() => {
                                                        void loadFlowScreenIds(
                                                          selectedFlowId,
                                                          true
                                                        );
                                                      }}
                                                      disabled={screensLoading}
                                                    >
                                                      {tTemplates(
                                                        "form.refreshFlowScreens"
                                                      )}
                                                    </Button>
                                                  </div>
                                                )}
                                                <FormMessage />
                                              </FormItem>
                                            )}
                                          />
                                        )}

                                        {flowHealth?.state === "issue" ? (
                                          <TemplateFlowHealthNotice
                                            health={flowHealth}
                                            variant="panel"
                                          />
                                        ) : null}
                                      </div>
                                    );
                                  })()}
                              </div>
                            );
                          })}

                          {buttons.length < 3 && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={addButton}
                              className="w-full"
                            >
                              <Plus className="h-4 w-4" />
                              {tTemplates("form.addButton")}
                            </Button>
                          )}
                        </div>
                      ) : null}
                    </TemplateFormSection>
                  )}

                {/* Telegram Fields */}
                {(targetPlatform === "telegram" ||
                  targetPlatform === "both") && (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold">
                      {tTemplates("form.telegramText")}
                    </h3>
                    <FormField
                      control={form.control}
                      name="telegramText"
                      render={({ field, fieldState }) => {
                        const vars = extractTemplateVariables(
                          field.value || ""
                        );
                        const charCount = (field.value || "").length;
                        return (
                          <FormItem>
                            <FormLabel>
                              {tTemplates("form.telegramText")}
                            </FormLabel>
                            <FormControl>
                              <Textarea
                                {...field}
                                rows={6}
                                maxLength={4096}
                                placeholder={tTemplates(
                                  "form.telegramPlaceholder"
                                )}
                                className={
                                  fieldState.error ? "border-destructive" : ""
                                }
                              />
                            </FormControl>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <div className="flex items-center gap-2">
                                {vars.length > 0 && (
                                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                                    {vars.map(v => `{{${v}}}`).join(", ")}
                                  </span>
                                )}
                              </div>
                              <span
                                className={
                                  charCount > 4000 ? "text-destructive" : ""
                                }
                              >
                                {charCount}/4096
                              </span>
                            </div>
                            <FormMessage />
                          </FormItem>
                        );
                      }}
                    />

                    <FormField
                      control={form.control}
                      name="telegramParseMode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{tTemplates("form.parseMode")}</FormLabel>
                          <Select
                            {...bindTemplateSelectField({
                              ...field,
                              value: field.value || "None",
                            })}
                          >
                            <TemplateSelectTrigger />
                            <SelectContent>
                              <SelectItem value="None">
                                {tTemplates("form.text")}
                              </SelectItem>
                              <SelectItem value="Markdown">Markdown</SelectItem>
                              <SelectItem value="HTML">HTML</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <div className="flex items-center gap-3">
                      <h3 className="shrink-0 text-sm font-medium tracking-tight">
                        Inline Keyboard
                      </h3>
                      <Separator className="min-w-8 flex-1" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={TEMPLATE_FORM_OPTIONAL_ACTION_CLASS}
                        onClick={() => {
                          const next = !hasTelegramButtons;
                          form.setValue("hasTelegramButtons", next, {
                            shouldDirty: true,
                          });
                          if (next && telegramButtonFields.length === 0) {
                            addTelegramButton();
                          }
                        }}
                      >
                        {hasTelegramButtons
                          ? tTemplates("form.removeTelegramButton")
                          : tTemplates("form.addTelegramButton")}
                      </Button>
                    </div>

                    {hasTelegramButtons && (
                      <div className="space-y-4">
                        {telegramButtonFields.map((field, index) => {
                          const button = telegramButtons[index] || field;
                          return (
                            <div
                              key={field.id}
                              className="p-4 border rounded-lg space-y-4"
                            >
                              <div className="flex items-center justify-between">
                                <Label>
                                  {tTemplates("form.button")} {index + 1}
                                </Label>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeTelegramButton(index)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>

                              <FormField
                                control={form.control}
                                name={`telegramButtons.${index}.text`}
                                render={({ field }) => (
                                  <FormItem>
                                    <FormLabel>
                                      {tTemplates("form.buttonText")}
                                    </FormLabel>
                                    <FormControl>
                                      <Input
                                        {...field}
                                        maxLength={64}
                                        placeholder={tTemplates(
                                          "form.buttonTextPlaceholder"
                                        )}
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />

                              <FormField
                                control={form.control}
                                name={`telegramButtons.${index}.url`}
                                render={({ field }) => (
                                  <FormItem>
                                    <FormLabel>
                                      {tTemplates("form.url")} (optional)
                                    </FormLabel>
                                    <FormControl>
                                      <Input
                                        {...field}
                                        type="url"
                                        placeholder="https://example.com"
                                      />
                                    </FormControl>
                                    <FormMessage />
                                  </FormItem>
                                )}
                              />

                              {!button.url && (
                                <FormField
                                  control={form.control}
                                  name={`telegramButtons.${index}.callbackData`}
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        {tTemplates("form.callbackData")}{" "}
                                        (optional)
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          {...field}
                                          maxLength={64}
                                          placeholder="callback_data"
                                        />
                                      </FormControl>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                              )}
                            </div>
                          );
                        })}

                        <Button
                          type="button"
                          variant="outline"
                          onClick={addTelegramButton}
                          className="w-full"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          {tTemplates("form.addTelegramButton")}
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {(targetPlatform !== "whatsapp" ||
                  selectedCategory !== "AUTHENTICATION") &&
                  (!useModalLayout || allVariableKeys.length > 0) && (
                    <TemplateFormSection
                      title={tTemplates("form.variablesEditor")}
                    >
                      {allVariableKeys.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {tTemplates("form.noVariables")}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {allVariableKeys.map(variable => (
                            <div
                              key={`template-variable-${variable}`}
                              className="rounded-lg border bg-muted/20 p-2.5"
                            >
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                                <div className="flex-1 space-y-1.5">
                                  <Label className="text-xs text-muted-foreground">
                                    {tTemplates("form.variableKey")}
                                  </Label>
                                  <Input
                                    value={
                                      variableRenameDraft[variable] || variable
                                    }
                                    onChange={event =>
                                      setVariableRenameDraft(prev => ({
                                        ...prev,
                                        [variable]: event.target.value,
                                      }))
                                    }
                                    className="h-8"
                                  />
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-8 self-end"
                                  onClick={() => applyVariableRename(variable)}
                                  disabled={
                                    !variableRenameDraft[variable] ||
                                    variableRenameDraft[variable] === variable
                                  }
                                >
                                  {tTemplates("form.applyRename")}
                                </Button>
                              </div>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {`{{${variable}}}`}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </TemplateFormSection>
                  )}
              </FieldGroup>
            </div>
            <div className="shrink-0 border-t bg-background px-4 py-3">
              {draftNotice ? (
                <div
                  role={draftNotice === "staleVersion" ? "alert" : "status"}
                  className={cn(
                    "mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs",
                    draftNotice === "staleVersion"
                      ? "border-destructive/40 bg-destructive/5 text-destructive"
                      : "bg-muted/40 text-muted-foreground"
                  )}
                >
                  <p className="min-w-0 flex-1">
                    {draftNotice === "staleVersion"
                      ? tTemplates("form.staleVersion")
                      : tTemplates("form.draftRestored")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0"
                    onClick={
                      draftNotice === "staleVersion"
                        ? reloadEditorToLatestVersion
                        : discardDraft
                    }
                  >
                    {draftNotice === "staleVersion"
                      ? tTemplates("form.staleVersionReload")
                      : tTemplates("form.draftDiscard")}
                  </Button>
                </div>
              ) : null}
              {(missingMetaIdForTarget ||
                missingDbIdForTarget ||
                metaEditDisabledReason) && (
                <p className="mb-2 text-xs text-destructive">
                  {metaEditDisabledReason ||
                    (missingMetaIdForTarget
                      ? tTemplates("form.editDisabledMissingMetaId")
                      : tTemplates("form.editDisabledMissingDbId"))}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                {onCancel && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancel}
                  >
                    {tTemplates("form.cancel")}
                  </Button>
                )}
                <Button type="submit" disabled={isSaveDisabled}>
                  {submitting && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {isEdit
                    ? tTemplates("form.updateTemplate")
                    : tTemplates("form.createTemplate")}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </div>
    </>
  );
}
