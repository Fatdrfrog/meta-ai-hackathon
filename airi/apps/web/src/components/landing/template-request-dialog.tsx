"use client";

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
import { DEFAULT_LOCALE, isLocale } from "@/i18n/locales";
import { getPublicTemplatePath } from "@/lib/landing/public-template-seo";
import {
  getPublicTemplate,
  getPublicTemplateText,
  type PublicTemplate,
} from "@/lib/landing/public-template-catalog";
import {
  PUBLIC_TEMPLATE_CONSENT_VERSION,
  publicTemplateRequestBodySchema,
  type PublicTemplateRequestBody,
  type PublicTemplateLocale,
} from "@/lib/landing/template-request";
import { CheckCheck, Loader2, Send } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import { TemplatePreview } from "./template-preview";
import landing from "./landing-workflow-studio.module.css";
import s from "./template-marketplace.module.css";

type RequestState = "idle" | "loading" | "accepted" | "processing" | "error";
type ErrorCode =
  | "unavailable"
  | "rate_limited"
  | "invalid_request"
  | "send_failed"
  | "unknown";
const ERROR_CODES: readonly ErrorCode[] = [
  "unavailable",
  "rate_limited",
  "invalid_request",
  "send_failed",
  "unknown",
];

export type TemplateRequestDialogProps = {
  templateId: string | null;
  onClose: () => void;
  source: "landing" | "marketplace";
  ready?: boolean;
  readinessLoading?: boolean;
  readinessUnavailable?: boolean;
};

// Keep the request session above Dialog: its responsive Modal/Drawer subtree
// remounts when the viewport crosses the mobile breakpoint.
function TemplateRequestSession({
  template,
  onClose,
  source,
  ready,
  readinessLoading,
  readinessUnavailable,
}: Omit<TemplateRequestDialogProps, "templateId"> & {
  template: PublicTemplate;
}) {
  const t = useTranslations("LandingDemo.templates");
  const all = useTranslations();
  const locale = useLocale();
  const fieldPrefix = useId();
  const requestId = useRef<string | null>(null);
  const submittedBody = useRef<PublicTemplateRequestBody | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const title = useRef<HTMLHeadingElement | null>(null);
  const closing = useRef(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [state, setState] = useState<RequestState>("idle");
  const [errorCode, setErrorCode] = useState<ErrorCode>("unknown");
  const errorId = `${fieldPrefix}-error`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || !consent || state === "loading") return;
    requestId.current ??= crypto.randomUUID();
    const body = publicTemplateRequestBodySchema.safeParse(
      submittedBody.current ?? {
        templateId: template.id,
        locale,
        name,
        email,
        phone,
        consent,
        consentVersion: PUBLIC_TEMPLATE_CONSENT_VERSION,
        website: String(
          new FormData(event.currentTarget).get("website") ?? ""
        ).slice(0, 200),
        requestId: requestId.current,
        source,
      }
    );
    if (!body.success) {
      setErrorCode("invalid_request");
      setState("error");
      return;
    }
    // A retry checks the same operation. Contact edits must not change a
    // request that the server may already have reserved or sent to Meta.
    submittedBody.current ??= body.data;
    setHasSubmitted(true);
    setState("loading");
    try {
      const response = await fetch("/api/landing/template-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submittedBody.current),
      });
      const result = await response.json();
      if (response.ok && result.status === "accepted") setState("accepted");
      else if (response.status === 202 && result.status === "processing")
        setState("processing");
      else {
        setErrorCode(
          ERROR_CODES.includes(result.code) ? result.code : "unknown"
        );
        setState("error");
      }
    } catch {
      setErrorCode("unknown");
      setState("error");
    }
  }

  function restartRequest() {
    submittedBody.current = null;
    requestId.current = null;
    setHasSubmitted(false);
    setState("idle");
  }

  function closeSession() {
    closing.current = true;
    onClose();
  }

  const definitiveFailure = state === "error" && errorCode === "send_failed";

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) closeSession();
      }}
    >
      <DialogContent
        className={[landing.explorer, s.dialog].join(" ")}
        onOpenAutoFocus={event => {
          event.preventDefault();
          if (!opener.current) {
            opener.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }
          // Announce the request without opening a keyboard for an offscreen input.
          title.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (closing.current && opener.current?.isConnected) {
            opener.current.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader className={s.dialogHeader}>
          <DialogTitle ref={title} tabIndex={-1}>
            {getPublicTemplateText(template, "title", all)}
          </DialogTitle>
          <DialogDescription>
            {t(ready ? "requestDescription" : "previewDescription")}
          </DialogDescription>
        </DialogHeader>
        <div
          data-vaul-no-drag
          className={[landing.explorerStory, s.dialogLayout].join(" ")}
        >
          {readinessLoading ? (
            <div className={s.notice} role="status">
              <Loader2 className="animate-spin" size={20} aria-hidden />
              <p>{t("checkingAvailability")}</p>
            </div>
          ) : !ready ? (
            <div className={s.notice}>
              <h3>
                {t(
                  readinessUnavailable
                    ? "availabilityUnavailable"
                    : "comingSoonTitle"
                )}
              </h3>
              <p>
                {t(
                  readinessUnavailable
                    ? "errors.unavailable"
                    : "comingSoonDescription"
                )}
              </p>
              <Button asChild variant="outline">
                <Link
                  href={getPublicTemplatePath(
                    isLocale(locale) ? locale : DEFAULT_LOCALE
                  )}
                  onClick={closeSession}
                >
                  {t("browseAll")}
                </Link>
              </Button>
            </div>
          ) : state === "accepted" ? (
            <div className={s.notice} role="status">
              <CheckCheck size={30} aria-hidden />
              <h3>{t("acceptedTitle")}</h3>
              <p>{t("acceptedDescription")}</p>
              <Button onClick={closeSession}>{t("done")}</Button>
            </div>
          ) : (
            <form
              onSubmit={submit}
              className={s.form}
              noValidate
              aria-busy={state === "loading"}
            >
              <div inert aria-hidden="true" className={s.honeypot}>
                <input
                  name="website"
                  autoComplete="off"
                  tabIndex={-1}
                  defaultValue=""
                />
              </div>
              <div className={s.field}>
                <Label htmlFor={`${fieldPrefix}-name`}>{t("name")}</Label>
                <Input
                  id={`${fieldPrefix}-name`}
                  name="name"
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  onChange={event => setName(event.target.value)}
                  disabled={hasSubmitted}
                  required
                />
              </div>
              <div className={s.field}>
                <Label htmlFor={`${fieldPrefix}-email`}>{t("email")}</Label>
                <Input
                  id={`${fieldPrefix}-email`}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  disabled={hasSubmitted}
                  required
                />
              </div>
              <div className={s.field}>
                <Label htmlFor={`${fieldPrefix}-phone`}>{t("phone")}</Label>
                <Input
                  id={`${fieldPrefix}-phone`}
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="+7 700 123 45 67"
                  maxLength={30}
                  value={phone}
                  onChange={event => setPhone(event.target.value)}
                  disabled={hasSubmitted}
                  required
                />
                <p>{t("phoneHint")}</p>
              </div>
              <div className={s.consent}>
                <Checkbox
                  id={`${fieldPrefix}-consent`}
                  checked={consent}
                  onCheckedChange={checked => setConsent(checked === true)}
                  disabled={hasSubmitted}
                />
                <Label htmlFor={`${fieldPrefix}-consent`}>{t("consent")}</Label>
              </div>
              <p className={s.privacy}>
                {t("privacyPrefix")}{" "}
                <Link href="/privacy" target="_blank" rel="noreferrer">
                  {t("privacyLink")}
                </Link>
              </p>
              {state === "processing" && (
                <div className={s.processing} role="status">
                  <strong>{t("processingTitle")}</strong>
                  <p>{t("processingDescription")}</p>
                </div>
              )}
              {state === "error" && (
                <p id={errorId} className={s.error} role="alert">
                  {t(`errors.${errorCode}`)}
                </p>
              )}
              <Button
                type={definitiveFailure ? "button" : "submit"}
                variant="secondary"
                fullWidth
                onClick={definitiveFailure ? restartRequest : undefined}
                className={s.requestButton}
                disabled={!consent || state === "loading"}
                aria-describedby={state === "error" ? errorId : undefined}
              >
                {state === "loading" ? (
                  <Loader2 className="animate-spin" size={17} aria-hidden />
                ) : (
                  <Send size={17} aria-hidden />
                )}
                {t(
                  definitiveFailure
                    ? "restartRequest"
                    : state === "processing"
                      ? "checkAgain"
                      : state === "loading"
                        ? "sending"
                        : "submit"
                )}
              </Button>
            </form>
          )}
          <TemplatePreview template={template} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TemplateRequestDialog({
  templateId,
  onClose,
  source,
  ready = false,
  readinessLoading = false,
  readinessUnavailable = false,
}: TemplateRequestDialogProps) {
  const locale = useLocale() as PublicTemplateLocale;
  const template = templateId
    ? getPublicTemplate(templateId, locale)
    : undefined;
  return template ? (
    <TemplateRequestSession
      key={template.id}
      template={template}
      onClose={onClose}
      source={source}
      ready={ready}
      readinessLoading={readinessLoading}
      readinessUnavailable={readinessUnavailable}
    />
  ) : null;
}
