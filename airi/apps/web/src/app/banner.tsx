// app/banner.tsx
"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  loadTrackingConsent,
  setTrackingConsent,
} from "@/lib/tracking-consent";
import { Cookie, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

function LandingConsentBanner({
  onAccept,
  onDecline,
}: {
  onAccept: () => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const t = useTranslations("LandingPage.cookieConsent");

  return (
    <div
      data-landing-cookie-consent
      className="border-b border-[#0f100e]/10 bg-[#f3f3ef] px-4 text-[#0f100e] sm:px-6 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-8xl flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-3xl text-xs leading-5 sm:text-sm">
          {t("description")}
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDecline}
            className="min-h-9 whitespace-normal rounded-md border-[#0f100e]/20 bg-transparent px-3 text-xs text-[#0f100e] shadow-none hover:bg-[#e8e8e2] hover:text-[#0f100e]"
          >
            {t("decline")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onAccept}
            className="min-h-9 whitespace-normal rounded-md bg-[#0f100e] px-3 text-xs text-[#f3f3ef] hover:bg-[#2a2c27]"
          >
            {t("accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Banner() {
  const pathname = usePathname();
  const t = useTranslations("LandingPage.cookieConsent");
  const [consentGiven, setConsentGiven] = useState("");
  const [landingConsentSlot, setLandingConsentSlot] =
    useState<HTMLElement | null>(null);
  const isLandingRoute = pathname === "/";
  const isAuthOrSetupRoute =
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/setup" ||
    pathname.startsWith("/setup/") ||
    pathname === "/onboarding" ||
    pathname.startsWith("/onboarding/") ||
    pathname.startsWith("/auth/");

  useEffect(() => {
    let cancelled = false;

    void loadTrackingConsent().then(consent => {
      if (!cancelled) setConsentGiven(consent);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isLandingRoute || consentGiven !== "pending") return;

    const findSlot = () => {
      const slot = document.getElementById("landing-consent-slot");
      if (!slot || slot.dataset.landingConsentReady !== "true") return false;

      setLandingConsentSlot(slot);
      return true;
    };

    if (findSlot()) return;

    // Wait for the landing page to hydrate before changing its server-rendered DOM.
    const observer = new MutationObserver(() => {
      if (findSlot()) observer.disconnect();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-landing-consent-ready"],
    });
    return () => observer.disconnect();
  }, [consentGiven, isLandingRoute]);

  const handleAcceptCookies = async () => {
    setConsentGiven("granted");
    await setTrackingConsent("granted");
  };

  const handleDeclineCookies = async () => {
    setConsentGiven("denied");
    await setTrackingConsent("denied");
  };

  if (isAuthOrSetupRoute || consentGiven !== "pending") {
    return null;
  }

  if (isLandingRoute) {
    return landingConsentSlot?.isConnected
      ? createPortal(
          <LandingConsentBanner
            onAccept={handleAcceptCookies}
            onDecline={handleDeclineCookies}
          />,
          landingConsentSlot
        )
      : null;
  }

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 max-w-md mx-auto">
      <Card className="border-2 shadow-lg">
        <CardContent className="p-4">
          <Alert className="border-0 p-0">
            <Cookie className="h-4 w-4" />
            <AlertDescription className="text-sm text-muted-foreground mb-4">
              {t("description")}
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDeclineCookies}
              className="text-xs"
            >
              <X className="h-3 w-3 mr-1" />
              {t("decline")}
            </Button>
            <Button size="sm" onClick={handleAcceptCookies} className="text-xs">
              <Cookie className="h-3 w-3 mr-1" />
              {t("accept")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
