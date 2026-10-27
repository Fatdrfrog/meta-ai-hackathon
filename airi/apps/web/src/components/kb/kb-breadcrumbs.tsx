"use client";

import { companySlugAtom } from "@/lib/navigation/company-slug-state";
import { useAtom } from "jotai";
import { BookOpen, ChevronRight, FileText, Home } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

interface BreadcrumbItem {
  label: string;
  href?: string;
  icon?: React.ReactNode;
}

export interface KBAncestor {
  id: string;
  title: string;
}

interface KBBreadcrumbsProps {
  workspaceId?: string;
  workspaceName?: string;
  companySlug?: string;
  articleId?: string;
  articleTitle?: string;
  ancestors?: KBAncestor[];
  mode?: "public" | "admin";
  showHome?: boolean;
  isNewArticle?: boolean;
}

export function KBBreadcrumbs({
  workspaceId,
  workspaceName,
  companySlug,
  articleId,
  articleTitle,
  ancestors = [],
  mode = "public",
  showHome = true,
  isNewArticle = false,
}: KBBreadcrumbsProps) {
  const t = useTranslations("KnowledgeBase.breadcrumbs");
  const [companySlugFromAtom] = useAtom(companySlugAtom);
  const effectiveCompanySlug = companySlug ?? companySlugFromAtom;

  const breadcrumbs: BreadcrumbItem[] = [];

  // Home/Workspace (admin only)
  if (showHome && mode === "admin" && workspaceId) {
    breadcrumbs.push({
      label: workspaceName || t("workspace"),
      href: `/panel/w/${workspaceId}`,
      icon: <Home className="h-4 w-4" />,
    });
  }

  // KB
  if (mode === "admin" && workspaceId) {
    breadcrumbs.push({
      label: t("knowledgeBase"),
      href: `/panel/w/${workspaceId}/kb`,
      icon: <BookOpen className="h-4 w-4" />,
    });
  }

  // Ancestors (root → immediate parent)
  for (const a of ancestors) {
    if (mode === "admin" && workspaceId) {
      breadcrumbs.push({
        label: a.title,
        href: `/panel/w/${workspaceId}/kb/${a.id}`,
        icon: <FileText className="h-4 w-4" />,
      });
    } else if (mode === "public" && effectiveCompanySlug) {
      breadcrumbs.push({
        label: a.title,
        href: `/${effectiveCompanySlug}/kb/${a.id}`,
        icon: <FileText className="h-4 w-4" />,
      });
    } else if (mode === "public") {
      breadcrumbs.push({
        label: a.title,
        href: `/kb/${a.id}`,
        icon: <FileText className="h-4 w-4" />,
      });
    }
  }

  // Current article or "New article"
  if (isNewArticle && mode === "admin" && workspaceId) {
    breadcrumbs.push({
      label: t("newArticle"),
      icon: <FileText className="h-4 w-4" />,
    });
  } else if (articleTitle && mode === "admin" && workspaceId && articleId) {
    breadcrumbs.push({
      label: t("editArticle"),
      icon: <FileText className="h-4 w-4" />,
    });
  }

  if (breadcrumbs.length === 0) {
    return null;
  }

  return (
    <nav
      className="mb-6 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-muted-foreground"
      aria-label="Breadcrumb"
    >
      {breadcrumbs.map((item, index) => (
        <div key={index} className="flex items-center">
          {index > 0 && <ChevronRight className="h-4 w-4 mx-1 flex-shrink-0" />}
          <div className="flex items-center space-x-1">
            {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
            {item.href ? (
              <Link
                href={item.href}
                className="hover:text-foreground transition-colors truncate max-w-[200px]"
                title={item.label}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className="text-foreground truncate max-w-[200px]"
                title={item.label}
              >
                {item.label}
              </span>
            )}
          </div>
        </div>
      ))}
    </nav>
  );
}
