"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SetupWizardState } from "./setup-wizard-state";

export const SIGNUP_REFERRAL_OTHER_VALUE = "other";

const SIGNUP_REFERRAL_SOURCE_OPTIONS = [
  { value: "Google Search", labelKey: "referralSourceGoogle" },
  { value: "LinkedIn", labelKey: "referralSourceLinkedIn" },
  { value: "Instagram", labelKey: "referralSourceInstagram" },
  { value: "Facebook", labelKey: "referralSourceFacebook" },
  { value: "TikTok", labelKey: "referralSourceTikTok" },
  { value: "YouTube", labelKey: "referralSourceYouTube" },
  { value: "Friend or colleague", labelKey: "referralSourceReferral" },
  { value: "Event or conference", labelKey: "referralSourceEvent" },
  { value: "Product Hunt", labelKey: "referralSourceProductHunt" },
] as const;

type TextField =
  | "fullName"
  | "companyName"
  | "phone"
  | "referralSource"
  | "referralSourceOther";

export function SetupRequiredStep({
  state,
  profileFieldsLocked,
  requiresProfile,
  requiresWorkspace,
  workspaceFieldsLocked,
  onPrivacyChange,
  onTextChange,
}: {
  state: SetupWizardState;
  profileFieldsLocked: boolean;
  requiresProfile: boolean;
  requiresWorkspace: boolean;
  workspaceFieldsLocked: boolean;
  onPrivacyChange: (value: boolean) => void;
  onTextChange: (field: TextField, value: string) => void;
}) {
  const tProfile = useTranslations("FinishProfilePage");
  const tCompany = useTranslations("AddCompanyForm");

  return (
    <>
      {requiresProfile ? (
        <div className="space-y-2">
          <Label
            htmlFor="full-name"
            className="text-sm font-bold text-foreground"
          >
            {tProfile("fullNameLabel")}
          </Label>
          <Input
            id="full-name"
            value={state.fullName}
            onChange={event => onTextChange("fullName", event.target.value)}
            placeholder={tProfile("fullNamePlaceholder")}
            required
            disabled={profileFieldsLocked}
            autoComplete="name"
            className="bg-background text-foreground border-[3px] border-foreground rounded-2xl p-3 h-12 focus-visible:ring-0 focus-visible:border-primary focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] transition-all"
          />
        </div>
      ) : null}

      {requiresWorkspace ? (
        <>
          {workspaceFieldsLocked ? (
            <Alert className="border-[3px] border-foreground rounded-2xl shadow-[3px_3px_0px_#000000] bg-[#cfffe1] dark:bg-emerald-950/40 text-black dark:text-foreground">
              <CheckCircle2 className="h-4 w-4 stroke-[3px]" />
              <AlertDescription className="font-bold">
                {tCompany("requiredStepLockedHint")}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm font-bold text-foreground">
              {tCompany("companyName")}
            </Label>
            <Input
              id="name"
              value={state.companyName}
              onChange={event =>
                onTextChange("companyName", event.target.value)
              }
              placeholder={tCompany("companyNamePlaceholder")}
              required
              disabled={workspaceFieldsLocked}
              className="bg-background text-foreground border-[3px] border-foreground rounded-2xl p-3 h-12 focus-visible:ring-0 focus-visible:border-primary focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] transition-all"
            />
          </div>
          <div className="space-y-2">
            <Label
              htmlFor="phone"
              className="text-sm font-bold text-foreground"
            >
              {tCompany("phoneNumber")}
            </Label>
            <Input
              id="phone"
              type="tel"
              value={state.phone}
              onChange={event => onTextChange("phone", event.target.value)}
              placeholder={tCompany("phoneNumberPlaceholder")}
              disabled={workspaceFieldsLocked}
              autoComplete="tel"
              className="bg-background text-foreground border-[3px] border-foreground rounded-2xl p-3 h-12 focus-visible:ring-0 focus-visible:border-primary focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] transition-all"
            />
          </div>
          <div className="space-y-2">
            <Label
              id="referral-source-label"
              htmlFor="referral-source"
              className="text-sm font-bold text-foreground"
            >
              {tCompany("referralSource")}
            </Label>
            <NativeSelect
              id="referral-source"
              value={state.referralSource}
              onChange={event => {
                const value = event.target.value;
                onTextChange("referralSource", value);
                if (value !== SIGNUP_REFERRAL_OTHER_VALUE) {
                  onTextChange("referralSourceOther", "");
                }
              }}
              disabled={workspaceFieldsLocked}
              aria-labelledby="referral-source-label"
              className="h-12 w-full rounded-2xl border-[3px] border-foreground bg-background p-3 pr-10 text-foreground shadow-none transition-all focus-visible:border-primary focus-visible:ring-0 focus-visible:translate-x-[1px] focus-visible:translate-y-[1px]"
            >
              <NativeSelectOption value="" disabled>
                {tCompany("referralSourcePlaceholder")}
              </NativeSelectOption>
              {SIGNUP_REFERRAL_SOURCE_OPTIONS.map(option => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {tCompany(option.labelKey)}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value={SIGNUP_REFERRAL_OTHER_VALUE}>
                {tCompany("referralSourceOther")}
              </NativeSelectOption>
            </NativeSelect>
          </div>
          {state.referralSource === SIGNUP_REFERRAL_OTHER_VALUE ? (
            <div className="space-y-2">
              <Label
                htmlFor="referral-source-other"
                className="text-sm font-bold text-foreground"
              >
                {tCompany("referralSourceOtherLabel")}
              </Label>
              <Input
                id="referral-source-other"
                value={state.referralSourceOther}
                onChange={event =>
                  onTextChange("referralSourceOther", event.target.value)
                }
                placeholder={tCompany("referralSourceOtherPlaceholder")}
                disabled={workspaceFieldsLocked}
                maxLength={300}
                className="bg-background text-foreground border-[3px] border-foreground rounded-2xl p-3 h-12 focus-visible:ring-0 focus-visible:border-primary focus-visible:translate-x-[1px] focus-visible:translate-y-[1px] transition-all"
              />
            </div>
          ) : null}
          {!workspaceFieldsLocked ? (
            <div className="flex items-start gap-3 rounded-2xl border-[3px] border-foreground bg-[#fdf0a6]/20 p-4 shadow-[3px_3px_0px_#000000] dark:shadow-[3px_3px_0px_rgba(255,255,255,0.15)]">
              <Checkbox
                id="privacy-accepted"
                checked={state.acceptedPrivacy}
                onCheckedChange={value => onPrivacyChange(Boolean(value))}
                className="mt-0.5 border-2 border-foreground rounded-md data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground shadow-[1px_1px_0px_#000000]"
              />
              <Label
                htmlFor="privacy-accepted"
                className="block text-sm font-bold leading-relaxed text-muted-foreground"
              >
                {tCompany.rich("privacyAgreement", {
                  privacy: chunks => (
                    <a
                      href="/privacy"
                      target="_blank"
                      rel="noreferrer"
                      className="font-extrabold text-foreground underline underline-offset-2 hover:text-primary transition-colors"
                    >
                      {chunks}
                    </a>
                  ),
                  terms: chunks => (
                    <a
                      href="/terms"
                      target="_blank"
                      rel="noreferrer"
                      className="font-extrabold text-foreground underline underline-offset-2 hover:text-primary transition-colors"
                    >
                      {chunks}
                    </a>
                  ),
                })}
              </Label>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
