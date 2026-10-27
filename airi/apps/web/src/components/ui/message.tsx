"use client";

import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type MessageProps = React.ComponentProps<"div"> & {
  from: "user" | "assistant";
};

function Message({ from, className, ...props }: MessageProps) {
  return (
    <div
      data-slot="message"
      data-from={from}
      className={cn(
        "group/message flex w-full items-end gap-2",
        from === "user" ? "justify-end" : "justify-start",
        className
      )}
      {...props}
    />
  );
}

type MessageContentProps = React.ComponentProps<"div"> & {
  variant?: "contained" | "flat";
};

function MessageContent({
  variant = "contained",
  className,
  ...props
}: MessageContentProps) {
  return (
    <div
      data-slot="message-content"
      data-variant={variant}
      className={cn(
        "max-w-[82%] rounded-lg text-sm leading-relaxed",
        variant === "contained" &&
          "bg-muted px-3 py-2 group-data-[from=user]/message:bg-primary group-data-[from=user]/message:text-primary-foreground",
        variant === "flat" && "px-0 py-1",
        className
      )}
      {...props}
    />
  );
}

type MessageAvatarProps = React.ComponentProps<typeof Avatar> & {
  src?: string | null;
  name?: string | null;
};

function initials(name?: string | null) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return parts.map(part => part[0]?.toUpperCase()).join("") || "AI";
}

function MessageAvatar({ src, name, className, ...props }: MessageAvatarProps) {
  return (
    <Avatar className={cn("size-8 ring-1 ring-border", className)} {...props}>
      {src ? <AvatarImage src={src} alt={name || ""} /> : null}
      <AvatarFallback className="text-[11px] font-medium">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export { Message, MessageAvatar, MessageContent };
