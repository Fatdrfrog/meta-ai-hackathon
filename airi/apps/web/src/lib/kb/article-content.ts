import { toArray } from "@icecore/shared/lib/value-utils";

export interface KBArticleVersionRow {
  content_mdx: string | null;
  version?: number | null;
  created_at?: string | null;
}

export type KBArticleVersionRelation =
  | KBArticleVersionRow
  | KBArticleVersionRow[]
  | null
  | undefined;

export interface KBArticleContentSource {
  title: string;
  status?: string | null;
  published_at?: string | null;
  draft_title?: string | null;
  draft_content_mdx?: string | null;
  kb_article_versions?: KBArticleVersionRelation;
}

export interface KBArticleLocalizationContentSource {
  title: string;
  status?: string | null;
  published_at?: string | null;
  draft_title?: string | null;
  draft_content_mdx?: string | null;
}

export function getLatestKBArticleVersion(
  versions: KBArticleVersionRelation
): KBArticleVersionRow | null {
  const normalizedVersions = toArray(versions);

  if (normalizedVersions.length === 0) {
    return null;
  }

  return [...normalizedVersions].sort((left, right) => {
    const versionDelta = (right.version ?? 0) - (left.version ?? 0);
    if (versionDelta !== 0) {
      return versionDelta;
    }

    const leftCreatedAt = left.created_at
      ? new Date(left.created_at).getTime()
      : 0;
    const rightCreatedAt = right.created_at
      ? new Date(right.created_at).getTime()
      : 0;

    return rightCreatedAt - leftCreatedAt;
  })[0]!;
}

export function getEffectiveKBArticleContent({
  draftContent,
  versions,
  fallback = "",
}: {
  draftContent?: string | null;
  versions?: KBArticleVersionRelation;
  fallback?: string;
}): string {
  if (draftContent !== null && draftContent !== undefined) {
    return draftContent;
  }

  return getLatestKBArticleVersion(versions)?.content_mdx ?? fallback;
}

export function resolveActiveKBArticleContent({
  article,
  activeLocalization,
  localizationVersion,
  isDefaultLocale,
  fallback = "",
}: {
  article: KBArticleContentSource;
  activeLocalization?: KBArticleLocalizationContentSource | null;
  localizationVersion?: KBArticleVersionRelation;
  isDefaultLocale: boolean;
  fallback?: string;
}): {
  title: string;
  content: string;
  status: string | null | undefined;
  published_at: string | null | undefined;
} {
  if (isDefaultLocale) {
    return {
      title: article.draft_title ?? article.title,
      content: getEffectiveKBArticleContent({
        draftContent: article.draft_content_mdx,
        versions: article.kb_article_versions,
        fallback,
      }),
      status: activeLocalization?.status ?? article.status,
      published_at: activeLocalization?.published_at ?? article.published_at,
    };
  }

  if (!activeLocalization) {
    return {
      title: "",
      content: fallback,
      status: article.status,
      published_at: article.published_at,
    };
  }

  return {
    title: activeLocalization.draft_title ?? activeLocalization.title,
    content: getEffectiveKBArticleContent({
      draftContent: activeLocalization.draft_content_mdx,
      versions: localizationVersion,
      fallback,
    }),
    status: activeLocalization.status ?? article.status,
    published_at: activeLocalization.published_at ?? article.published_at,
  };
}

export function getKBArticleUpdatedAt({
  articleUpdatedAt,
  versions,
}: {
  articleUpdatedAt?: string | null;
  versions?: KBArticleVersionRelation;
}): string | null {
  return (
    getLatestKBArticleVersion(versions)?.created_at ?? articleUpdatedAt ?? null
  );
}
