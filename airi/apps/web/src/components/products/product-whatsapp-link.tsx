"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import { QrCode } from "lucide-react";
import QRCodeLib from "qrcode";
import { useState } from "react";
import { createProductsWhatsAppLink } from "./products-client";

const COPY = PRODUCTS_COPY.whatsapp;

type LinkState =
  | { phase: "idle" | "making" | "failed" }
  | { phase: "ready"; url: string; qr: string; expiresAt: number };

/**
 * "Send from WhatsApp": a one-time code, as a QR to scan and a link to tap,
 * that opens WhatsApp to Airi with the code written in. Sending it links the
 * owner's phone, and the shelf videos they then send to Airi land here.
 */
export function WhatsAppLinkButton({
  workspaceId,
  number,
  variant = "outline",
}: {
  workspaceId: string;
  /** Airi's number, as the owner reads it. */
  number: string;
  variant?: "default" | "outline";
}) {
  const [link, setLink] = useState<LinkState>({ phase: "idle" });

  const makeCode = async () => {
    setLink({ phase: "making" });
    try {
      const { url, expiresAt } = await createProductsWhatsAppLink(workspaceId);
      const qr = await QRCodeLib.toDataURL(url, { width: 352, margin: 1 });
      setLink({ phase: "ready", url, qr, expiresAt: Date.parse(expiresAt) });
    } catch {
      setLink({ phase: "failed" });
    }
  };

  return (
    <Popover
      onOpenChange={open => {
        // A fresh code each time one has run out, or none was made yet.
        const usable =
          link.phase === "ready" && link.expiresAt > Date.now() + 60_000;
        if (open && !usable && link.phase !== "making") void makeCode();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={variant} size="sm">
          <QrCode aria-hidden="true" />
          {COPY.sendFromWhatsApp}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" collisionPadding={16} className="w-80 p-5">
        <p className="text-[15px] font-medium">{COPY.panelTitle}</p>
        <p className="mt-1 text-sm text-pretty text-muted-foreground">
          {COPY.panelSteps(number)}
        </p>
        <div className="mt-4 flex justify-center">
          {link.phase === "ready" ? (
            // A data URL made here; next/image has nothing to optimize.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={link.qr}
              alt={COPY.panelTitle}
              className="size-44 rounded-lg border border-foreground/10 bg-white p-2"
            />
          ) : (
            <div
              role={link.phase === "making" ? "status" : undefined}
              aria-label={link.phase === "making" ? COPY.makingCode : undefined}
              className="size-44 animate-pulse rounded-lg bg-foreground/[0.06]"
            />
          )}
        </div>
        {link.phase === "failed" ? (
          <div className="mt-3 flex flex-col items-center gap-2 text-center">
            <p role="alert" className="text-sm text-destructive">
              {COPY.codeFailed}
            </p>
            <Button size="sm" variant="outline" onClick={() => void makeCode()}>
              {PRODUCTS_COPY.tryAgain}
            </Button>
          </div>
        ) : link.phase === "ready" ? (
          <div className="mt-3 flex flex-col items-center gap-1.5 text-center">
            <Button asChild size="sm">
              <a href={link.url} target="_blank" rel="noreferrer">
                {COPY.openWhatsApp}
              </a>
            </Button>
            <p className="text-xs text-muted-foreground">{COPY.codeLifetime}</p>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
