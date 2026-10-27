"use client";

import { Button } from "@/components/ui/button";
import {
  ServiceMessageInput as Input,
  ServiceGroupError,
  ServiceMessageFieldErrorsContext,
  useServiceGroupError,
} from "./service-message-field";
import type { ScenarioWhatsAppContactConfig } from "@icecore/scenario-contracts";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useContext, useState } from "react";
import { ScenarioCollapsibleSection } from "../../../scenario-collapsible-section";
import { createServiceMessageEntityId } from "./service-message-ids";

/** Optional card fields that sit behind "More details". */
const CONTACT_DETAIL_FIELDS = [
  "email",
  "company",
  "title",
  "websiteUrl",
] as const satisfies readonly (keyof ScenarioWhatsAppContactConfig)[];

export function ServiceMessageContactFields({
  contacts,
  onChange,
}: {
  contacts: ScenarioWhatsAppContactConfig[];
  onChange: (contacts: ScenarioWhatsAppContactConfig[]) => void;
}) {
  const t = useTranslations("Scenarios");
  // One error for every contact; the name inputs point at it.
  const nameError = useServiceGroupError("contacts");
  const fieldErrors = useContext(ServiceMessageFieldErrorsContext);
  const [contactKeys, setContactKeys] = useState(() =>
    contacts.map(() => createServiceMessageEntityId())
  );
  const keyedContacts = contacts.map((contact, index) => ({
    contact,
    key: contactKeys[index] ?? "restored-contact-" + index,
    index,
  }));
  const update = (
    index: number,
    field: keyof ScenarioWhatsAppContactConfig,
    value: string
  ) =>
    onChange(
      contacts.map((contact, current) =>
        current === index ? { ...contact, [field]: value } : contact
      )
    );

  return (
    <div className="space-y-2" data-sm-field="contacts">
      {keyedContacts.map(({ contact, key, index }) => (
        <div
          key={key}
          className={`space-y-1.5${index > 0 ? " border-t border-border/50 pt-2" : ""}`}
        >
          <div className="flex items-end gap-1.5">
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
              <Input
                className="nodrag h-8 min-w-0 text-xs"
                fieldKey={"contacts." + index + ".formattedName"}
                label={t("whatsappContactNameLabel")}
                value={contact.formattedName || ""}
                placeholder={t("whatsappContactNamePlaceholder")}
                {...(contact.formattedName?.trim() ? {} : nameError.inputProps)}
                onChange={event =>
                  update(index, "formattedName", event.target.value)
                }
              />
              <Input
                className="nodrag h-8 text-xs"
                fieldKey={"contacts." + index + ".phone"}
                label={t("whatsappContactPhoneLabel")}
                type="tel"
                value={contact.phone || ""}
                placeholder={t("whatsappContactPhonePlaceholder")}
                onChange={event => update(index, "phone", event.target.value)}
              />
            </div>
            {contacts.length > 1 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="nodrag nopan h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={t("whatsappServiceDeleteContact")}
                title={t("whatsappServiceDeleteContact")}
                onPointerDown={event => event.stopPropagation()}
                onClick={() => {
                  setContactKeys(current =>
                    current.filter((_, keyIndex) => keyIndex !== index)
                  );
                  onChange(contacts.filter((_, current) => current !== index));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
          <ScenarioCollapsibleSection
            variant="inline"
            title={t("whatsappContactMoreDetails")}
            defaultOpen={CONTACT_DETAIL_FIELDS.some(field =>
              contact[field]?.trim()
            )}
            errorCount={
              CONTACT_DETAIL_FIELDS.filter(field =>
                fieldErrors.has("contacts." + index + "." + field)
              ).length
            }
            keepMounted
          >
            <div className="grid grid-cols-2 gap-1.5 pt-1">
              <Input
                className="nodrag h-8 text-xs"
                fieldKey={"contacts." + index + ".email"}
                label={t("whatsappContactEmailLabel")}
                type="email"
                value={contact.email || ""}
                placeholder={t("whatsappContactEmailPlaceholder")}
                onChange={event => update(index, "email", event.target.value)}
              />
              <Input
                className="nodrag h-8 text-xs"
                fieldKey={"contacts." + index + ".company"}
                label={t("whatsappContactCompanyLabel")}
                value={contact.company || ""}
                placeholder={t("whatsappContactCompanyPlaceholder")}
                onChange={event => update(index, "company", event.target.value)}
              />
              <Input
                className="nodrag h-8 text-xs"
                fieldKey={"contacts." + index + ".title"}
                label={t("whatsappContactTitleLabel")}
                value={contact.title || ""}
                placeholder={t("whatsappContactTitlePlaceholder")}
                onChange={event => update(index, "title", event.target.value)}
              />
              <Input
                className="nodrag col-span-2 h-8 text-xs"
                fieldKey={"contacts." + index + ".websiteUrl"}
                label={t("whatsappContactWebsiteLabel")}
                type="url"
                value={contact.websiteUrl || ""}
                placeholder={t("whatsappContactWebsitePlaceholder")}
                onChange={event =>
                  update(index, "websiteUrl", event.target.value)
                }
              />
            </div>
          </ScenarioCollapsibleSection>
        </div>
      ))}
      <ServiceGroupError fieldKey="contacts" id={nameError.id} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="nodrag h-8 w-full border-dashed"
        onClick={() => {
          setContactKeys(current => [
            ...current,
            createServiceMessageEntityId(),
          ]);
          onChange([...contacts, { version: 1 }]);
        }}
      >
        <Plus className="mr-2 h-3.5 w-3.5" aria-hidden />
        {t("whatsappServiceAddContact")}
      </Button>
    </div>
  );
}
