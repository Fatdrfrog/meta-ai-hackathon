"use client";

import { Loader2 } from "lucide-react";
import { useEffect } from "react";

export default function InstagramFacebookCallbackCompatPage() {
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const nextUrl = new URL("/instagram/callback", window.location.origin);
    nextUrl.search = currentUrl.search;
    nextUrl.hash = currentUrl.hash;
    window.location.replace(nextUrl.toString());
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Redirecting...</span>
      </div>
    </div>
  );
}
