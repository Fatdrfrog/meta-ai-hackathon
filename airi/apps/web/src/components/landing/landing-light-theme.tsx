"use client";

import { useEffect } from "react";

type ResolvedTheme = "light" | "dark";

function getStoredTheme(): string | null {
  try {
    return window.localStorage.getItem("theme");
  } catch {
    return null;
  }
}

function resolveStoredTheme(): ResolvedTheme {
  const storedTheme = getStoredTheme();

  if (storedTheme === "dark") {
    return "dark";
  }

  if (
    storedTheme === "system" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

function applyDocumentTheme(theme: ResolvedTheme) {
  const root = document.documentElement;

  root.classList.remove("light", "dark");
  root.classList.add(theme);
  root.style.colorScheme = theme;
}

export function LandingLightTheme() {
  useEffect(() => {
    applyDocumentTheme("light");

    return () => {
      applyDocumentTheme(resolveStoredTheme());
    };
  }, []);

  return null;
}
