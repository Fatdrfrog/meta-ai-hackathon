"use client";

import { cn } from "@/lib/utils";
import type { ScenarioTriggerConfig, TranslateFn } from "../../types";
import type { MessageTriggerEditorModel } from "./message-trigger-editor-model";
import { Globe, Instagram, Mail, MessageCircle } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";

function renderChannelIcon(value: string): ReactNode {
  const channel = value.trim().toLowerCase();
  if (channel === "whatsapp" || channel === "telegram") {
    const label = channel === "whatsapp" ? "WhatsApp" : "Telegram";
    return (
      <Image
        src={`/${channel}.svg`}
        alt={label}
        width={14}
        height={14}
        className="h-3.5 w-3.5 object-contain"
      />
    );
  }
  if (channel === "email") return <Mail className="h-3.5 w-3.5" />;
  if (channel === "instagram") {
    return <Instagram className="h-3.5 w-3.5" />;
  }
  if (channel === "web_widget") return <Globe className="h-3.5 w-3.5" />;
  return <MessageCircle className="h-3.5 w-3.5" />;
}

export function ChannelFilterEditor({
  channels,
  onChange,
  t,
}: {
  channels: MessageTriggerEditorModel["channels"];
  onChange: (delta: Partial<ScenarioTriggerConfig>) => void;
  t: TranslateFn;
}) {
  const toggleChannel = (channel: string) => {
    const nextEnabled = new Set(channels.enabledChannelSet);
    const currentlyEnabled = nextEnabled.has(channel);
    if (currentlyEnabled && nextEnabled.size <= 1) return;
    if (currentlyEnabled) nextEnabled.delete(channel);
    else nextEnabled.add(channel);

    const enabledInOptionOrder = channels.options
      .map(option => option.id)
      .filter(optionId => nextEnabled.has(optionId));
    onChange({
      channelFilter:
        enabledInOptionOrder.length === channels.options.length
          ? []
          : enabledInOptionOrder,
    });
  };

  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-2">
      <p className="text-[11px] font-medium text-muted-foreground">
        {t("channels")}
      </p>
      {channels.options.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {t("noChannelsFound")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {channels.options.map(channel => {
            const enabled = channels.enabledChannelSet.has(channel.id);
            return (
              <button
                key={channel.id}
                type="button"
                onClick={() => toggleChannel(channel.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors",
                  enabled
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border/60 bg-background/60 text-muted-foreground"
                )}
                aria-pressed={enabled}
                aria-label={channel.label}
                title={channel.label}
              >
                <span
                  className={cn(
                    "inline-flex h-5 w-5 items-center justify-center rounded-full border",
                    enabled
                      ? "border-primary/40 bg-background"
                      : "border-border/60 bg-muted/30"
                  )}
                >
                  {renderChannelIcon(channel.id)}
                </span>
                <span className="font-medium">{channel.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
