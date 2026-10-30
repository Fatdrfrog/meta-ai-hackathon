"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PRODUCTS_COPY } from "@/lib/products/copy";
import {
  PRODUCTS_WHATSAPP_PAIRING_TTL_MS,
  type ProductsWhatsAppLinkedPhoneRecord,
  type ProductsWhatsAppLinkRequestRecord,
  type ProductsWhatsAppLinkResponse,
} from "@/lib/products/types";
import { cn } from "@/lib/utils";
import { QrCode } from "lucide-react";
import QRCodeLib from "qrcode";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import {
  approveProductsWhatsAppRequest,
  denyProductsWhatsAppRequest,
  fetchProductsWhatsAppLink,
  openProductsWhatsAppLink,
  ProductDraftError,
  productsWhatsAppLinkUrl,
  unlinkProductsWhatsAppPhone,
} from "./products-client";

const COPY = PRODUCTS_COPY.whatsapp;
/** How often the open panel checks for a phone asking to be linked. */
export const WHATSAPP_LINK_POLL_MS = 3000;
// The shop is opened again a minute before it would close to phones, so the
// QR keeps working however long the panel stays open. It's timed from when
// this page heard it open, for the window's whole lifetime: the server's
// clock and this one needn't agree.
const REOPEN_AFTER_MS = PRODUCTS_WHATSAPP_PAIRING_TTL_MS - 60_000;
// Whatever goes wrong with the timing, the shop isn't opened more often.
const MIN_REOPEN_GAP_MS = 30_000;

/** A masked phone or a number stays on one line. */
const unbroken = (text: string) => text.replace(/ /g, "\u{a0}");

const errorCodeOf = (error: unknown) =>
  error instanceof ProductDraftError ? error.code : null;

/** The ask an admin answered has left the panel: gone, or taken elsewhere. */
const isGone = (error: unknown) =>
  errorCodeOf(error) === "whatsapp_link_not_found" ||
  errorCodeOf(error) === "whatsapp_link_linked_elsewhere";

/**
 * "Send from WhatsApp": a QR to scan, and a link to tap, that opens WhatsApp
 * to Airi with a message naming the shop. Sending it asks to link the phone,
 * and an admin confirms the phone here; the shelf videos it then sends to
 * Airi land in the workspace. While the panel is open, the shop is open to
 * phones asking, and the panel checks every few seconds for one that did.
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
  const url = productsWhatsAppLinkUrl(workspaceId);
  const ids = useId();
  const titleId = `${ids}-title`;
  const stepsId = `${ids}-steps`;
  const [open, setOpen] = useState(false);
  // Whether the shop is open to phones asking: opening the panel opens it,
  // and only the QR depends on that. It stays closed while another shop in
  // airi has its name.
  const [shop, setShop] = useState<"opening" | "open" | "failed" | "taken">(
    "opening"
  );
  // When the shop last opened, by this page's own steady clock.
  const [openedAt, setOpenedAt] = useState(0);
  const [linkingAnother, setLinkingAnother] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // An element to move the focus to once it's on the page.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const acting = useRef(false);
  const { mutate } = useSWRConfig();
  const { data: panel } = useSWR<ProductsWhatsAppLinkResponse>(
    open ? url : null,
    fetchProductsWhatsAppLink,
    {
      refreshInterval: WHATSAPP_LINK_POLL_MS,
      // Each opening's first state comes from opening the shop.
      revalidateOnMount: false,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      errorRetryInterval: WHATSAPP_LINK_POLL_MS,
    }
  );

  const openShop = useCallback(async () => {
    setShop("opening");
    try {
      const opened = await openProductsWhatsAppLink(workspaceId);
      if (!opened.pairing) throw new ProductDraftError("failed");
      await mutate(url, opened, { revalidate: false });
      setOpenedAt(performance.now());
      setShop("open");
    } catch (error) {
      setShop(
        errorCodeOf(error) === "whatsapp_link_shop_name_taken"
          ? "taken"
          : "failed"
      );
    }
  }, [workspaceId, url, mutate]);

  // Kept open while the panel is: again before it closes, or at once when a
  // check finds it closed (this page's timers were held up, say).
  const lapsed = panel !== undefined && !panel.pairing;
  useEffect(() => {
    if (!open || shop !== "open") return;
    const now = performance.now();
    const wait = Math.max(
      lapsed ? 0 : openedAt + REOPEN_AFTER_MS - now,
      openedAt + MIN_REOPEN_GAP_MS - now,
      0
    );
    const timer = setTimeout(() => void openShop(), wait);
    return () => clearTimeout(timer);
  }, [open, shop, openedAt, lapsed, openShop]);

  const linkUrl = panel?.pairing?.url ?? null;
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  useEffect(() => {
    if (!linkUrl) return;
    let current = true;
    QRCodeLib.toDataURL(linkUrl, { width: 352, margin: 1 }).then(
      image => {
        if (current) setQr({ url: linkUrl, image });
      },
      // Without the picture, the link below still opens WhatsApp.
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [linkUrl]);
  const closed = shop === "failed" || shop === "taken";
  const qrImage = !closed && qr && qr.url === linkUrl ? qr.image : null;

  const requests = panel?.requests ?? [];
  // The workspace's own number shows in the hint below, and needs no unlinking.
  const linked = (panel?.linkedPhones ?? []).filter(
    phone => phone.via !== "connected_number"
  );
  const businessNumbers = panel?.businessNumbers ?? [];
  const asking = requests.length > 0;
  const showQr = !asking && (linked.length === 0 || linkingAnother);

  // A phone's ask takes the QR's place; whoever was on the QR moves to it.
  const firstRequest = requests[0]?.id ?? null;
  useEffect(() => {
    if (firstRequest && document.activeElement === document.body)
      setFocusTarget(`${ids}-ask-${firstRequest}`);
  }, [firstRequest, ids]);

  useEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget);
    if (!element) return;
    element.focus();
    setFocusTarget(null);
  }, [focusTarget, panel]);

  const perform = async (
    action: () => Promise<ProductsWhatsAppLinkResponse>,
    after: (next: ProductsWhatsAppLinkResponse) => void,
    goneMessage: (error: unknown) => string | null = () => null
  ) => {
    if (acting.current) return;
    acting.current = true;
    setFailure(null);
    try {
      const next = await action();
      await mutate(url, next, { revalidate: false });
      after(next);
    } catch (error) {
      if (isGone(error)) {
        // What's gone leaves the panel, and the focus with it.
        void mutate(url);
        setFocusTarget(titleId);
      }
      setFailure(isGone(error) ? goneMessage(error) : COPY.actionFailed);
    } finally {
      acting.current = false;
    }
  };

  const approve = (request: ProductsWhatsAppLinkRequestRecord) =>
    perform(
      () => approveProductsWhatsAppRequest(workspaceId, request.id),
      next => {
        setLinkingAnother(false);
        const phone = next.linkedPhones.find(
          entry => entry.phone === request.phone
        );
        setFocusTarget(phone ? `${ids}-linked-${phone.id}` : titleId);
      },
      error =>
        errorCodeOf(error) === "whatsapp_link_linked_elsewhere"
          ? COPY.phoneLinkedElsewhere
          : COPY.requestExpired
    );
  const deny = (request: ProductsWhatsAppLinkRequestRecord) =>
    perform(
      () => denyProductsWhatsAppRequest(workspaceId, request.id),
      () => setFocusTarget(titleId)
    );
  const unlink = (phone: ProductsWhatsAppLinkedPhoneRecord) =>
    perform(
      () => unlinkProductsWhatsAppPhone(workspaceId, phone.id),
      () => setFocusTarget(titleId)
    );

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        setFailure(null);
        setLinkingAnother(false);
        // Each time it opens, the shop opens to phones for 15 minutes more.
        if (next) void openShop();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant={variant} size="sm">
          <QrCode aria-hidden="true" />
          {COPY.sendFromWhatsApp}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        aria-labelledby={titleId}
        // The title, not "Yes, link it": a keypress mustn't link a phone unread.
        onOpenAutoFocus={event => {
          event.preventDefault();
          document.getElementById(titleId)?.focus();
        }}
        // Never wider than the screen; on a phone, the content column.
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-5 max-sm:w-[calc(100vw-2rem)]"
      >
        <p
          id={titleId}
          tabIndex={-1}
          className="text-[15px] font-medium outline-none"
        >
          {COPY.panelTitle}
        </p>
        <div aria-live="polite">
          {asking ? (
            <div className="mt-3">
              {requests.length > 1 ? (
                <p className="mb-2 text-sm text-pretty text-amber-700 dark:text-amber-300">
                  {COPY.severalAsked}
                </p>
              ) : null}
              <ul className="divide-y divide-foreground/10 border-y border-foreground/10">
                {requests.map(request => {
                  const askId = `${ids}-ask-${request.id}`;
                  const nameId = `${ids}-name-${request.id}`;
                  const describedBy = request.profileName
                    ? `${askId} ${nameId}`
                    : askId;
                  return (
                    <li key={request.id} className="py-3">
                      <p
                        id={askId}
                        tabIndex={-1}
                        className="text-sm break-words text-pretty outline-none"
                      >
                        {COPY.askPhone(unbroken(request.phone))}
                      </p>
                      {request.profileName ? (
                        <p
                          id={nameId}
                          className="mt-0.5 text-xs break-words text-pretty text-muted-foreground"
                        >
                          {COPY.profileName(request.profileName)}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          aria-describedby={describedBy}
                          onClick={() => void approve(request)}
                        >
                          {COPY.confirmPhone}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-describedby={describedBy}
                          onClick={() => void deny(request)}
                          // Level with the raised face of "Yes, link it".
                          className="-translate-y-1"
                        >
                          {COPY.denyPhone}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
        {linked.length > 0 ? (
          <div className="mt-3">
            <ul className="divide-y divide-foreground/10 border-y border-foreground/10">
              {linked.map(phone => (
                <li
                  key={phone.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <p
                    id={`${ids}-linked-${phone.id}`}
                    tabIndex={-1}
                    className="min-w-0 text-sm outline-none"
                  >
                    {COPY.linkedPhone(unbroken(phone.phone))}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-describedby={`${ids}-linked-${phone.id}`}
                    onClick={() => void unlink(phone)}
                  >
                    {COPY.unlink}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-pretty text-muted-foreground">
              {COPY.linkedSteps(unbroken(number))}
            </p>
          </div>
        ) : null}
        {failure ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {showQr ? (
          <div className={linked.length > 0 ? "mt-4" : "mt-1"}>
            <p
              id={stepsId}
              tabIndex={-1}
              className="text-sm text-pretty text-muted-foreground outline-none"
            >
              {COPY.panelSteps}
            </p>
            <div className="mt-4 flex justify-center">
              {qrImage ? (
                // A data URL made here; next/image has nothing to optimize.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrImage}
                  alt={COPY.panelTitle}
                  className="size-44 rounded-lg border border-foreground/10 bg-white p-2"
                />
              ) : (
                <div
                  role={shop === "opening" ? "status" : undefined}
                  aria-label={shop === "opening" ? COPY.makingQr : undefined}
                  className={cn(
                    "size-44 rounded-lg bg-foreground/[0.06]",
                    !closed && "motion-safe:animate-pulse"
                  )}
                />
              )}
            </div>
            {closed ? (
              <div className="mt-3 flex flex-col items-center gap-2 text-center">
                <p
                  role="alert"
                  className="text-sm text-pretty text-destructive"
                >
                  {shop === "taken" ? COPY.shopNameTaken : COPY.qrFailed}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openShop()}
                >
                  {PRODUCTS_COPY.tryAgain}
                </Button>
              </div>
            ) : linkUrl ? (
              <div className="mt-3 flex justify-center">
                <Button asChild size="sm">
                  <a href={linkUrl} target="_blank" rel="noreferrer">
                    {COPY.openWhatsApp}
                  </a>
                </Button>
              </div>
            ) : null}
          </div>
        ) : !asking ? (
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => {
              setLinkingAnother(true);
              setFocusTarget(stepsId);
            }}
          >
            {COPY.linkAnother}
          </Button>
        ) : null}
        {!asking && businessNumbers.length > 0 ? (
          <p className="mt-4 text-xs text-pretty text-muted-foreground">
            {COPY.businessNumbers(businessNumbers.map(unbroken))}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
