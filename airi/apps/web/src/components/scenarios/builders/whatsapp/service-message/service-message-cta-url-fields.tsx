"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  WHATSAPP_SERVICE_MESSAGE_LIMITS,
  type ScenarioWhatsAppServiceMessagePayload,
} from "@icecore/scenario-contracts";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  fieldErrorMessage,
  type ServiceMessageFieldErrorMap,
} from "./service-message-field-errors";
import type { WhatsAppServiceSignupLink } from "./service-message-resources";

type CtaUrlMessage = Extract<
  ScenarioWhatsAppServiceMessagePayload,
  { kind: "cta_url" }
>;

type CtaUrlSource = CtaUrlMessage["urlSource"];

/** No real signup link can use this id; it only names the empty state. */
const NO_SIGNUP_LINKS_VALUE = "__no_signup_links__";

function CtaUrlFieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="mt-0.5 text-[10px] leading-snug text-destructive">
      {message}
    </p>
  );
}

function CtaUrlFixedUrlInput({
  url,
  error,
  onChange,
}: {
  url: string;
  error: string | undefined;
  onChange: (urlSource: CtaUrlSource) => void;
}) {
  const t = useTranslations("Scenarios");
  return (
    <Input
      className={cn(
        "nodrag h-8 border-zinc-300/80 bg-white text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950",
        error && "border-destructive ring-1 ring-destructive/60"
      )}
      type="url"
      value={url}
      placeholder={t("actionCtaLinkPlaceholder")}
      aria-label={t("whatsappServiceWebsiteLinkLabel")}
      aria-invalid={error ? true : undefined}
      onPointerDown={event => event.stopPropagation()}
      onChange={event => onChange({ kind: "fixed", url: event.target.value })}
    />
  );
}

function CtaUrlSignupLinkSelect({
  signupLinkId,
  signupLinks,
  loading,
  error,
  onChange,
}: {
  signupLinkId: string;
  signupLinks: WhatsAppServiceSignupLink[];
  loading: boolean;
  error: string | undefined;
  onChange: (urlSource: CtaUrlSource) => void;
}) {
  const t = useTranslations("Scenarios");
  return (
    <Select
      value={signupLinkId}
      onValueChange={nextSignupLinkId => {
        if (nextSignupLinkId === NO_SIGNUP_LINKS_VALUE) return;
        const link = signupLinks.find(item => item.id === nextSignupLinkId);
        onChange({
          kind: "signup_link",
          signupLinkId: nextSignupLinkId,
          signupLinkName: link?.displayName || link?.metaSignupId,
          fallbackUrl: link?.deepLinkUrl,
        });
      }}
    >
      <SelectTrigger
        aria-label={t("whatsappSignupLinkSelectLabel")}
        aria-invalid={error ? true : undefined}
        className={cn(
          "nodrag h-8 w-full min-w-0 border-zinc-300/80 bg-white px-2 text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950",
          error && "border-destructive ring-1 ring-destructive/60"
        )}
      >
        <SelectValue placeholder={t("whatsappSignupLinkSelectPlaceholder")} />
        {loading ? (
          <span className="ms-auto flex items-center">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            <span className="sr-only">{t("loadingItems")}</span>
          </span>
        ) : null}
      </SelectTrigger>
      <SelectContent>
        {signupLinks.length > 0 ? (
          signupLinks.map(link => (
            <SelectItem key={link.id} value={link.id}>
              {link.displayName || link.metaSignupId}
            </SelectItem>
          ))
        ) : (
          <SelectItem value={NO_SIGNUP_LINKS_VALUE} disabled>
            {t(loading ? "loadingItems" : "whatsappSignupLinkEmpty")}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/** Website / subscribe-link fields nested under the Website action grid. */
export function ServiceMessageCtaUrlFields({
  message,
  signupLinks,
  signupLinksLoading = false,
  fieldErrors,
  onChange,
}: {
  message: CtaUrlMessage;
  signupLinks: WhatsAppServiceSignupLink[];
  signupLinksLoading?: boolean;
  fieldErrors?: ServiceMessageFieldErrorMap;
  onChange: (message: CtaUrlMessage) => void;
}) {
  const t = useTranslations("Scenarios");
  const errors = fieldErrors ?? new Map();
  const buttonLabelError = fieldErrorMessage(errors, "buttonLabel");
  const urlError = fieldErrorMessage(errors, "urlSource.url");
  const signupError = fieldErrorMessage(errors, "urlSource");
  const changeUrlSource = (urlSource: CtaUrlSource) =>
    onChange({ ...message, urlSource });

  return (
    <div
      className="flex w-full min-w-0 flex-col gap-1.5 px-2.5 pb-1.5"
      data-testid="whatsapp-service-cta-url-fields"
    >
      <div data-sm-field="buttonLabel">
        <Input
          className={cn(
            "nodrag h-8 border-zinc-300/80 bg-white text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950",
            buttonLabelError && "border-destructive ring-1 ring-destructive/60"
          )}
          maxLength={WHATSAPP_SERVICE_MESSAGE_LIMITS.button.label}
          value={message.buttonLabel}
          placeholder={t("actionCtaLinkLabelPlaceholder")}
          aria-label={t("buttonText")}
          aria-invalid={buttonLabelError ? true : undefined}
          onPointerDown={event => event.stopPropagation()}
          onChange={event =>
            onChange({ ...message, buttonLabel: event.target.value })
          }
        />
        <CtaUrlFieldError message={buttonLabelError} />
      </div>
      <Select
        value={message.urlSource.kind}
        onValueChange={kind =>
          onChange({
            ...message,
            urlSource:
              kind === "signup_link"
                ? { kind: "signup_link", signupLinkId: "" }
                : { kind: "fixed", url: "" },
          })
        }
      >
        <SelectTrigger
          aria-label={t("whatsappServiceLinkType")}
          className="nodrag h-8 w-full min-w-0 border-zinc-300/80 bg-white px-2 text-[11px] shadow-none dark:border-zinc-700 dark:bg-zinc-950"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fixed">{t("whatsappServiceFixedUrl")}</SelectItem>
          <SelectItem value="signup_link">
            {t("whatsappActionKindSignupLink")}
          </SelectItem>
        </SelectContent>
      </Select>
      {message.urlSource.kind === "fixed" ? (
        <div data-sm-field="urlSource.url">
          <CtaUrlFixedUrlInput
            url={message.urlSource.url}
            error={urlError}
            onChange={changeUrlSource}
          />
          <CtaUrlFieldError message={urlError} />
        </div>
      ) : (
        <div data-sm-field="urlSource">
          <CtaUrlSignupLinkSelect
            signupLinkId={message.urlSource.signupLinkId}
            signupLinks={signupLinks}
            loading={signupLinksLoading}
            error={signupError}
            onChange={changeUrlSource}
          />
          <CtaUrlFieldError message={signupError} />
        </div>
      )}
    </div>
  );
}
