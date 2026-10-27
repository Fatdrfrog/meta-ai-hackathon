"use client";

import type { ScenarioActionSourceId } from "@/components/scenarios/types";
import { cn } from "@/lib/utils";
import { Bot, Instagram, Mail, MessageSquareText, Users } from "lucide-react";
import Image from "next/image";

export function ActionSourceIcon({
  sourceId,
  className = "h-3.5 w-3.5",
}: {
  sourceId: ScenarioActionSourceId;
  className?: string;
}) {
  if (sourceId === "whatsapp") {
    return (
      <Image
        src="/whatsapp.svg"
        alt=""
        width={14}
        height={14}
        className={cn(className, "object-contain")}
      />
    );
  }

  if (sourceId === "telegram") {
    return (
      <Image
        src="/telegram.svg"
        alt=""
        width={14}
        height={14}
        className={cn(className, "object-contain")}
      />
    );
  }

  if (sourceId === "instagram") {
    return <Instagram className={cn(className, "text-pink-600")} />;
  }

  if (sourceId === "email") {
    return <Mail className={cn(className, "text-sky-600")} />;
  }

  if (sourceId === "web_widget") {
    return <MessageSquareText className={cn(className, "text-violet-600")} />;
  }

  if (sourceId === "team") {
    return <Users className={cn(className, "text-amber-600")} />;
  }

  return <Bot className={cn(className, "text-emerald-600")} />;
}
