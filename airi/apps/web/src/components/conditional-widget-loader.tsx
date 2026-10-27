"use client";

import { AIRI_PRODUCT_KB_COMPANY_SLUG } from "@/lib/airi-product-context";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

type WidgetWindow = Window & {
  __AIRI_WIDGET_LOADED__?: boolean;
  __ICECORE_WIDGET_LOADED__?: boolean;
};

const WIDGET_LOADER_BASE_SRC = "https://widget.airi.chat/loader.js";
const WIDGET_LOADER_VERSION = "20260508";
const WIDGET_LOADER_SRC = `${WIDGET_LOADER_BASE_SRC}?v=${WIDGET_LOADER_VERSION}`;
const WIDGET_CLIENT_KEY = "widget_ae31aeac8e113a9e8c22d2fce36985c9";
const WIDGET_SCRIPT_SELECTOR = `script[src="${WIDGET_LOADER_SRC}"][data-client-key="${WIDGET_CLIENT_KEY}"]`;
const ANY_WIDGET_SCRIPT_SELECTOR = `script[src^="${WIDGET_LOADER_BASE_SRC}"][data-client-key="${WIDGET_CLIENT_KEY}"]`;

const PUBLIC_WIDGET_PATHS = [
  "/",
  "/whatsapp-marketing-delivery",
  "/meta-ads-mcp",
  "/mcp",
  "/about",
  "/privacy",
  "/terms",
  "/refunds",
  "/security",
] as const;

function isPrivateIpv4Host(hostname: string): boolean {
  const segments = hostname.split(".");
  if (segments.length !== 4) return false;

  const octets = segments.map(segment => Number.parseInt(segment, 10));
  if (octets.some(octet => Number.isNaN(octet))) return false;

  const [first, second] = octets;

  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  );
}

function isCanonicalPublicWidgetHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === "airi.chat" || normalizedHostname === "www.airi.chat"
  );
}

export function shouldLoadWidgetOnHost(hostname: string): boolean {
  if (process.env.NEXT_PUBLIC_FORCE_WIDGET_IN_DEV === "true") {
    return true;
  }

  if (isCanonicalPublicWidgetHost(hostname)) {
    return true;
  }

  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  return !(
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    isPrivateIpv4Host(hostname)
  );
}

function isPublicRoute(pathname: string): boolean {
  if (
    PUBLIC_WIDGET_PATHS.includes(
      pathname as (typeof PUBLIC_WIDGET_PATHS)[number]
    )
  ) {
    return true;
  }
  // airi.chat's own help center: /airichat/kb or /airichat/kb/[article].
  // Customers' public knowledge bases are theirs, so airi.chat's sales chat
  // stays off them.
  const productKbPrefix = `/${AIRI_PRODUCT_KB_COMPANY_SLUG}/kb`;
  return (
    pathname === productKbPrefix || pathname.startsWith(`${productKbPrefix}/`)
  );
}

export function ConditionalWidgetLoader() {
  const pathname = usePathname();
  const showWidget = isPublicRoute(pathname);

  useEffect(() => {
    const cleanupWidget = () => {
      document.getElementById("airi-widget-host")?.remove();
      document
        .querySelectorAll<HTMLScriptElement>(ANY_WIDGET_SCRIPT_SELECTOR)
        .forEach(script => script.remove());
      (window as WidgetWindow).__AIRI_WIDGET_LOADED__ = false;
      (window as WidgetWindow).__ICECORE_WIDGET_LOADED__ = false;
    };

    const currentHost = window.location.hostname;
    const canLoadWidget = shouldLoadWidgetOnHost(currentHost);

    if (showWidget && canLoadWidget) {
      document
        .querySelectorAll<HTMLScriptElement>(ANY_WIDGET_SCRIPT_SELECTOR)
        .forEach(script => {
          if (script.src !== WIDGET_LOADER_SRC) {
            script.remove();
          }
        });

      const existingScript = document.querySelector<HTMLScriptElement>(
        WIDGET_SCRIPT_SELECTOR
      );

      if (existingScript) {
        return;
      }

      const script = document.createElement("script");
      script.src = WIDGET_LOADER_SRC;
      script.async = true;
      script.setAttribute("data-client-key", WIDGET_CLIENT_KEY);
      document.body.appendChild(script);
      return;
    }

    cleanupWidget();
  }, [showWidget]);

  return null;
}
