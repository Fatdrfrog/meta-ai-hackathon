"use client";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EmbeddedSignupButton } from "./embedded-signup-button";

interface EmbeddedSignupWithQRProps {
  workspaceId: string;
  businessName?: string;
  businessEmail?: string;
  businessPhone?: string;
  disabled?: boolean;
}

const ELIGIBILITY_CHECKBOX_ID = "whatsapp-business-app-eligibility";
const CONTINUE_HINT_ID = "whatsapp-business-app-continue-hint";

export function EmbeddedSignupWithQR({
  workspaceId,
  businessName,
  businessEmail,
  businessPhone,
  disabled = false,
}: EmbeddedSignupWithQRProps) {
  const t = useTranslations("EmbeddedSignupWithQR");
  const [confirmedEligibility, setConfirmedEligibility] = useState(false);
  const waitingForConfirmation = !disabled && !confirmedEligibility;

  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{t("title")}</ItemTitle>
        <ItemDescription className="line-clamp-none">
          {t("description")}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="flex-col items-end gap-1">
        <EmbeddedSignupButton
          label={t("button.start")}
          flow="coexistence"
          workspaceId={workspaceId}
          businessName={businessName}
          businessEmail={businessEmail}
          businessPhone={businessPhone}
          allowBusinessAppMigration
          size="sm"
          disabled={disabled || !confirmedEligibility}
        />
        {waitingForConfirmation ? (
          <p
            id={CONTINUE_HINT_ID}
            className="text-xs text-muted-foreground"
            aria-live="polite"
          >
            {t("button.hint")}
          </p>
        ) : null}
      </ItemActions>
      <ItemFooter className="flex-col items-stretch gap-3">
        <Field orientation="horizontal">
          <Checkbox
            id={ELIGIBILITY_CHECKBOX_ID}
            checked={confirmedEligibility}
            disabled={disabled}
            aria-describedby={
              waitingForConfirmation ? CONTINUE_HINT_ID : undefined
            }
            onCheckedChange={checked => {
              setConfirmedEligibility(checked === true);
            }}
          />
          <FieldContent>
            <FieldLabel
              htmlFor={ELIGIBILITY_CHECKBOX_ID}
              className="font-normal"
            >
              {t("eligibility.confirmTitle")}
            </FieldLabel>
            <FieldDescription>
              {t("eligibility.confirmDescription")}
            </FieldDescription>
          </FieldContent>
        </Field>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t("instructions.warning")}</li>
          <li>{t("instructions.eligibilityWarning")}</li>
        </ul>
      </ItemFooter>
    </Item>
  );
}
