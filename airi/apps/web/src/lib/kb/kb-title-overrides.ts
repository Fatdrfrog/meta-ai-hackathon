import type { Locale } from "@/i18n/locales";
import { resolveKBDefaultLocale } from "./kb-localization-actions";

type KBArticleTitleRecord = {
  id: string;
  title?: string | null;
};

type KBTreeArticleTitleRecord = KBArticleTitleRecord & {
  draft_title?: string | null;
  default_locale?: string | null;
};

type KBTreeArticleTitleLocalization = {
  article_id: string;
  locale: string;
  title?: string | null;
  draft_title?: string | null;
};

export function pickKBArticleTitle(
  ...candidates: Array<string | null | undefined>
): string {
  for (const candidate of candidates) {
    const title = candidate?.trim();
    if (title) {
      return title;
    }
  }

  return "";
}

export function isKBPlaceholderTitle(title: string | null | undefined): boolean {
  const normalized = title?.trim().toLowerCase() ?? "";
  return normalized.length === 0 || normalized === "untitled";
}

export function reconcileKBArticleTitleOverrides(
  overrides: Record<string, string>,
  articles: readonly KBArticleTitleRecord[]
): Record<string, string> {
  const entries = Object.entries(overrides);
  if (entries.length === 0) return overrides;

  const titleByArticleId = new Map(
    articles.map(article => [article.id, article.title ?? ""])
  );
  const next: Record<string, string> = {};
  let changed = false;

  for (const [articleId, overrideTitle] of entries) {
    if (!titleByArticleId.has(articleId)) {
      changed = true;
      continue;
    }

    if (titleByArticleId.get(articleId) === overrideTitle) {
      changed = true;
      continue;
    }

    next[articleId] = overrideTitle;
  }

  return changed ? next : overrides;
}

export function getKBEffectiveArticleTitle({
  articleId,
  initialTitle,
  titleOverrides,
}: {
  articleId?: string;
  initialTitle?: string | null;
  titleOverrides: Record<string, string>;
}): string {
  if (
    articleId &&
    Object.prototype.hasOwnProperty.call(titleOverrides, articleId)
  ) {
    return titleOverrides[articleId];
  }

  return initialTitle ?? "";
}

export function isKBDefaultArticleLocale(
  locale: Locale,
  defaultLocale: unknown
): boolean {
  return locale === resolveKBDefaultLocale(defaultLocale);
}

export type KBTreeArticleLocaleState = {
  status: string | null;
  hasDraft: boolean;
};

type KBTreeArticleLocaleRecord = KBTreeArticleTitleLocalization & {
  status?: string | null;
  draft_content_mdx?: string | null;
};

export function getKBTreeArticleLocaleState({
  article,
  localizations,
  locale,
}: {
  article: KBTreeArticleTitleRecord & { status?: string | null };
  localizations: readonly KBTreeArticleLocaleRecord[];
  locale?: string | null;
}): KBTreeArticleLocaleState {
  const defaultLocale = resolveKBDefaultLocale(article.default_locale);
  const preferredLocale = locale?.trim() || defaultLocale;
  const isDefaultLocale = preferredLocale === defaultLocale;
  const localization = localizations.find(
    row => row.article_id === article.id && row.locale === preferredLocale
  );

  const status = localization
    ? (localization.status ?? "draft")
    : isDefaultLocale
      ? (article.status ?? null)
      : null;
  const hasDraft = Boolean(
    localization
      ? localization.draft_title != null ||
          localization.draft_content_mdx != null
      : isDefaultLocale && article.draft_title != null
  );

  return { status, hasDraft };
}

export function getKBTreeArticleTitle({
  article,
  localizations,
  locale,
}: {
  article: KBTreeArticleTitleRecord;
  localizations: readonly KBTreeArticleTitleLocalization[];
  locale?: string | null;
}): string {
  const defaultLocale = resolveKBDefaultLocale(article.default_locale);
  const preferredLocale = locale?.trim() || defaultLocale;
  const preferredLocalization = localizations.find(
    localization =>
      localization.article_id === article.id &&
      localization.locale === preferredLocale
  );
  const defaultLocalization = localizations.find(
    localization =>
      localization.article_id === article.id &&
      localization.locale === defaultLocale
  );

  return pickKBArticleTitle(
    preferredLocalization?.draft_title,
    preferredLocalization?.title,
    defaultLocalization?.draft_title,
    defaultLocalization?.title,
    article.draft_title,
    article.title
  );
}
