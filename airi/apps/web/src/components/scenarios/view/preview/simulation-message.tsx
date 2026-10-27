"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Contact, MapPin, ShoppingBag } from "lucide-react";
import { listScenarioWhatsAppServiceOptions } from "@icecore/scenario-contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  WhatsAppActionRenderer,
  type WhatsAppActionRendererButton,
} from "../../builders/whatsapp/action-renderer";
import { projectServiceMessageEditor } from "../../builders/whatsapp/service-message/service-message-editor-model";
import type {
  ScenarioSimulationEvent,
  ScenarioSimulationMessage,
} from "@/lib/scenarios/scenario-simulation-types";
import { SimulationFlowForm } from "./simulation-flow-form";

function SimulationMessage({
  message,
  enabled,
  onEvent,
}: {
  message: ScenarioSimulationMessage;
  enabled: boolean;
  onEvent: (event: ScenarioSimulationEvent, label?: string) => void;
}) {
  const t = useTranslations("Scenarios");
  const config = message.serviceMessage;
  const data = config?.message;
  const projection = config
    ? projectServiceMessageEditor(config, {
        callingReady: true,
        hasWhatsAppCoexistence: false,
      })
    : null;
  const [listOpen, setListOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const options = config ? listScenarioWhatsAppServiceOptions(config) : [];
  const choose = (option: { id: string; label: string }) =>
    onEvent({ kind: "choice", payload: option.id }, option.label);
  const quickReplies = (cardIndex?: number): WhatsAppActionRendererButton[] =>
    options
      .filter(option => option.cardIndex === cardIndex)
      .map(option => ({
        type: "quick_reply",
        label: option.label,
        disabled: !enabled,
        onClick: () => choose(option),
      }));
  // List rows open from their menu button; carousel replies sit on each card.
  const buttons: WhatsAppActionRendererButton[] =
    data?.kind === "list"
      ? [
          {
            type: "quick_reply",
            label: data.buttonLabel,
            disabled: !enabled,
            onClick: () => setListOpen(v => !v),
          },
        ]
      : quickReplies();
  if (data?.kind === "flow")
    buttons.push({
      type: "flow",
      label: data.flowConfig?.ctaText || t("simulationOpenForm"),
      disabled: !enabled || !data.flowConfig?.screens.length,
      onClick: () => setFlowOpen(v => !v),
    });
  if (data?.kind === "cta_url")
    buttons.push({ type: "url", label: data.buttonLabel, disabled: true });
  if (data?.kind === "voice_call")
    buttons.push({ type: "phone", label: data.buttonLabel, disabled: true });
  if (
    data?.kind === "location_request" ||
    data?.kind === "request_contact_info"
  )
    buttons.push({
      type: data.kind,
      label: t(
        data.kind === "location_request"
          ? "simulationShareLocation"
          : "simulationShareContact"
      ),
      disabled: !enabled,
      onClick: () =>
        onEvent({
          kind: "message",
          text: t(
            data.kind === "location_request"
              ? "simulationLocationShared"
              : "simulationContactShared"
          ),
        }),
    });
  const flow = data?.kind === "flow" ? data.flowConfig : null;
  const media = projection?.media;
  const mediaFormat = media?.mediaType?.toUpperCase() as
    | "IMAGE"
    | "VIDEO"
    | "DOCUMENT"
    | "AUDIO"
    | "STICKER"
    | undefined;
  return (
    <div className="min-w-0 space-y-2">
      {message.dynamic && (
        <Badge variant="outline">{t("simulationAiPreview")}</Badge>
      )}
      {data?.kind === "contacts" ? (
        <div className="rounded-lg border bg-background p-3 text-sm">
          <Contact className="mb-2 size-4" />
          {data.contacts.map(contact => (
            <p key={contact.formattedName}>{contact.formattedName}</p>
          ))}
        </div>
      ) : data?.kind === "location" ? (
        <div className="rounded-lg border bg-background p-3 text-sm">
          <MapPin className="mb-2 size-4" />
          {data.location.name ||
            data.location.address ||
            `${data.location.latitude}, ${data.location.longitude}`}
        </div>
      ) : data?.kind === "commerce" ? (
        <div className="rounded-lg border bg-background p-3 text-sm">
          <ShoppingBag className="mb-2 size-4" />
          {data.commerce.bodyText || t("simulationCatalogPreview")}
          <Badge className="mt-2" variant="outline">
            {t("simulationDynamicContent")}
          </Badge>
        </div>
      ) : (
        <WhatsAppActionRenderer
          surface="message"
          fitContent
          align="start"
          bodyText={
            message.dynamic ? t("simulationAiMessage") : message.bodyText
          }
          headerText={projection?.headerText}
          footerText={projection?.footerText}
          headerMediaFormat={mediaFormat}
          headerMediaUrl={media?.url}
          buttons={buttons}
        />
      )}
      {listOpen && data?.kind === "list" && (
        <div className="space-y-3 rounded-lg border bg-background p-3">
          {data.sections.map(section => (
            <div key={section.id} className="space-y-1">
              <p className="break-words text-sm font-medium">{section.title}</p>
              {section.rows.map(row => (
                <Button
                  key={row.id}
                  className="h-auto w-full justify-start whitespace-normal py-2 text-start"
                  variant="outline"
                  disabled={!enabled}
                  onClick={() => choose({ id: row.id, label: row.title })}
                >
                  <span className="min-w-0 break-words">
                    {row.title}
                    {row.description && (
                      <span className="block text-xs text-muted-foreground">
                        {row.description}
                      </span>
                    )}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        </div>
      )}
      {data?.kind === "media_carousel" && (
        <div className="flex snap-x gap-2 overflow-x-auto pb-2">
          {data.cards.map((card, cardIndex) => (
            <div key={card.id} className="w-56 shrink-0 snap-start">
              <WhatsAppActionRenderer
                surface="message"
                fitContent
                bodyText={card.bodyText ?? ""}
                headerMediaFormat={
                  card.media.mediaType === "video" ? "VIDEO" : "IMAGE"
                }
                headerMediaUrl={card.media.url}
                buttons={
                  card.interaction.kind === "quick_replies"
                    ? quickReplies(cardIndex)
                    : [
                        {
                          type: "url",
                          label: card.interaction.buttonLabel,
                          disabled: true,
                        },
                      ]
                }
              />
            </div>
          ))}
        </div>
      )}
      {data?.kind === "appointment" && (
        <Badge variant="outline">{t("simulationDynamicContent")}</Badge>
      )}
      {data?.kind === "flow" && !flow?.screens.length && (
        <Badge variant="outline">{t("simulationFormUnavailable")}</Badge>
      )}
      {flowOpen && flow && (
        <SimulationFlowForm
          config={flow}
          enabled={enabled}
          onSubmit={values =>
            onEvent({ kind: "flow", values }, t("simulationFormSubmitted"))
          }
        />
      )}
    </div>
  );
}

export { SimulationMessage };
