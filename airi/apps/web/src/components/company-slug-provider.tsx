"use client";

import { companySlugAtom } from "@/lib/navigation/company-slug-state";
import { useSetAtom } from "jotai";
import { usePathname } from "next/navigation";
import { useEffect, useMemo } from "react";
import useSWR from "swr";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
};

export default function CompanySlugProvider() {
  const setCompanySlug = useSetAtom(companySlugAtom);
  const pathname = usePathname();

  const parts = useMemo(
    () => (pathname ? pathname.split("/").filter(Boolean) : []),
    [pathname]
  );

  const isWorkspacePath =
    parts[0] === "panel" && parts[1] === "w" && !!parts[2];

  // Only fetch company context for authenticated panel routes.
  // Public routes don't need this API call (it returns 401 for unauthenticated
  // users, causing unnecessary SWR error retries).
  const isPanelRoute = parts[0] === "panel";

  const url = useMemo(() => {
    if (!pathname || !isPanelRoute) return null;
    if (isWorkspacePath) return `/api/company-context?workspaceId=${parts[2]}`;
    return `/api/company-context`;
  }, [pathname, isPanelRoute, isWorkspacePath, parts]);

  const { data, error, isLoading } = useSWR(url, fetcher, {
    revalidateOnFocus: false,
  });

  useEffect(() => {
    if (isLoading || !pathname) return;

    if (data?.companySlug) {
      setCompanySlug(data.companySlug);
      return;
    }

    if (isWorkspacePath) {
      setCompanySlug(null);
      return;
    }

    const first = parts[0];
    if (first && !["panel", "api", "_next", "favicon.ico"].includes(first)) {
      setCompanySlug(first);
    } else {
      setCompanySlug(null);
    }
  }, [
    data,
    error,
    isLoading,
    isWorkspacePath,
    parts,
    pathname,
    setCompanySlug,
  ]);

  return null;
}
