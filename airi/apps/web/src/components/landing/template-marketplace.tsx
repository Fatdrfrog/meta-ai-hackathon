"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LandingHeaderViewer } from "@/lib/landing/landing-header-viewer";
import {
  publicTemplateReadinessSchema,
  type PublicTemplateLocale,
} from "@/lib/landing/template-request";
import {
  PUBLIC_TEMPLATE_FORMATS,
  PUBLIC_TEMPLATE_GOALS,
  PUBLIC_TEMPLATE_INDUSTRIES,
  PUBLIC_TEMPLATE_USE_CASES,
  filterPublicTemplates,
  getPublicTemplateFilters,
  getPublicTemplateText,
  getPublicTemplate,
  isPublicTemplateAvailableInLocale,
  type PublicTemplate,
} from "@/lib/landing/public-template-catalog";
import {
  PUBLIC_TEMPLATE_LANGUAGES,
  getPublicTemplatePath,
} from "@/lib/landing/public-template-seo";
import { locales } from "@/i18n/locales";
import { ArrowLeft, ArrowRight, Search, SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { LandingPageHeader } from "./page-header";
import { TemplatePreview } from "./template-preview";
import { TemplateRequestDialog } from "./template-request-dialog";
import landing from "./landing-workflow-studio.module.css";
import s from "./template-marketplace.module.css";

function TemplateSearchForm({
  id,
  initialQuery,
  onSearch,
}: {
  id: string;
  initialQuery: string;
  onSearch: (query: string) => void;
}) {
  const t = useTranslations("LandingDemo.templates");
  const [query, setQuery] = useState(initialQuery);
  return (
    <form
      className={s.search}
      onSubmit={event => {
        event.preventDefault();
        onSearch(query);
      }}
    >
      <Label htmlFor={id}>{t("search")}</Label>
      <div>
        <Input
          id={id}
          name="q"
          type="search"
          value={query}
          maxLength={120}
          placeholder={t("searchPlaceholder")}
          onChange={event => setQuery(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="icon"
          aria-label={t("search")}
        >
          <Search size={18} aria-hidden />
        </Button>
      </div>
    </form>
  );
}

export function TemplateMarketplace({
  readyTemplateIds,
  unavailableTemplateIds = [],
  viewer,
  readinessLoading = false,
  templateId,
}: {
  readyTemplateIds?: string[];
  unavailableTemplateIds?: string[];
  viewer?: LandingHeaderViewer;
  readinessLoading?: boolean;
  templateId?: string;
}) {
  const t = useTranslations("LandingDemo.templates");
  const all = useTranslations();
  const locale = useLocale() as PublicTemplateLocale;
  const [availability, setAvailability] = useState({
    locale,
    ids: [] as string[],
    unavailableIds: [] as string[],
    loading: true,
    unavailable: false,
  });
  useEffect(() => {
    if (readyTemplateIds !== undefined) return;
    const controller = new AbortController();
    void fetch(
      `/api/landing/template-request?locale=${encodeURIComponent(locale)}`,
      { signal: controller.signal }
    )
      .then(async response => {
        if (!response.ok) throw new Error("Availability request failed");
        const result = publicTemplateReadinessSchema.parse(
          await response.json()
        );
        if (!controller.signal.aborted)
          setAvailability({
            locale,
            ids: result.readyTemplateIds,
            unavailableIds: result.unavailableTemplateIds,
            loading: false,
            unavailable: false,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setAvailability({
            locale,
            ids: [],
            unavailableIds: [],
            loading: false,
            unavailable: true,
          });
      });
    return () => controller.abort();
  }, [locale, readyTemplateIds]);
  const availabilityMatchesLocale = availability.locale === locale;
  const readyIds =
    readyTemplateIds ?? (availabilityMatchesLocale ? availability.ids : []);
  const unavailableIds =
    readyTemplateIds !== undefined
      ? unavailableTemplateIds
      : availabilityMatchesLocale
        ? availability.unavailableIds
        : [];
  const loading =
    readyTemplateIds === undefined
      ? !availabilityMatchesLocale || availability.loading
      : readinessLoading;
  const unavailable =
    readyTemplateIds === undefined &&
    availabilityMatchesLocale &&
    availability.unavailable;
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const fieldsId = useId();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filters = getPublicTemplateFilters(params);
  const templates = filterPublicTemplates(filters, key => all(key), locale);
  const detailTemplate = templateId
    ? getPublicTemplate(templateId, locale)
    : undefined;
  const availableLocales = locales.filter(
    language =>
      !detailTemplate ||
      isPublicTemplateAvailableInLocale(detailTemplate, language)
  );
  const related = detailTemplate
    ? filterPublicTemplates(
        { q: "", industry: "", goal: "", format: "" },
        all,
        locale
      )
        .filter(template => template.id !== detailTemplate.id)
        .sort(
          (a, b) =>
            Number(a.useCase !== detailTemplate.useCase) -
              Number(b.useCase !== detailTemplate.useCase) ||
            Number(a.industry !== detailTemplate.industry) -
              Number(b.industry !== detailTemplate.industry) ||
            Number(a.goal !== detailTemplate.goal) -
              Number(b.goal !== detailTemplate.goal)
        )
        .slice(0, 3)
    : [];
  const activeFilters = Boolean(
    filters.q ||
      filters.industry ||
      filters.goal ||
      filters.format ||
      filters.useCase
  );

  function updateFilter(
    key: "q" | "industry" | "goal" | "format" | "useCase",
    value: string
  ) {
    const next = new URLSearchParams(params.toString());
    if (value.trim()) next.set(key, value.trim());
    else next.delete(key);
    const query = next.toString();
    router.replace(pathname + (query ? `?${query}` : ""), { scroll: false });
  }

  function resetFilters() {
    const next = new URLSearchParams(params.toString());
    for (const key of ["q", "industry", "goal", "format", "useCase"])
      next.delete(key);
    const query = next.toString();
    router.replace(pathname + (query ? `?${query}` : ""), { scroll: false });
  }

  function requestAction(template: PublicTemplate) {
    const ready = readyIds.includes(template.id);
    const title = getPublicTemplateText(template, "title", all);
    return (
      <>
        <Button
          className={ready ? s.requestButton : s.previewAction}
          variant={ready ? "secondary" : "outline"}
          onClick={event => {
            // Safari clears button focus before click; preserve the dialog's opener.
            event.currentTarget.focus({ preventScroll: true });
            setSelectedId(template.id);
          }}
          aria-label={t(ready ? "getTemplateLabel" : "viewTemplateLabel", {
            title,
          })}
        >
          {t(ready ? "getTemplate" : "viewTemplate")}
          <ArrowRight size={16} aria-hidden />
        </Button>
        <span className={s.availability}>
          {t(
            loading
              ? "checkingAvailability"
              : unavailable || unavailableIds.includes(template.id)
                ? "availabilityUnavailable"
                : ready
                  ? "ready"
                  : "comingSoon"
          )}
        </span>
      </>
    );
  }

  return (
    <div className={[landing.root, s.marketplace].join(" ")}>
      <LandingPageHeader
        viewer={viewer}
        languageSwitcherActiveLocale={locale}
        languageSwitcherAvailableLocales={availableLocales}
        languageSwitcherSyncSearchParam
      />
      <div className={s.content}>
        <div className={s.detailNavigation}>
          <Link href="/" className={s.back}>
            <ArrowLeft size={16} aria-hidden />
            {t("backHome")}
          </Link>
          {detailTemplate && (
            <Link href={getPublicTemplatePath(locale)} className={s.back}>
              {t("browseAll")}
            </Link>
          )}
        </div>
        <section
          className={s.intro}
          aria-labelledby="template-marketplace-title"
        >
          <h1 id="template-marketplace-title">
            {detailTemplate
              ? getPublicTemplateText(detailTemplate, "title", all)
              : t("seo.title")}
          </h1>
          <p>
            {detailTemplate
              ? getPublicTemplateText(detailTemplate, "description", all)
              : t("seo.intro")}
          </p>
        </section>

        {detailTemplate ? (
          <>
            <section className={s.detailLayout} aria-label={t("previewLabel")}>
              <TemplatePreview template={detailTemplate} />
              <div className={s.detailInfo}>
                <h2>{t("seo.detailHeading")}</h2>
                <dl className={s.detailProperties}>
                  <div>
                    <dt>{t("useCase")}</dt>
                    <dd>{t(`useCases.${detailTemplate.useCase}`)}</dd>
                  </div>
                  <div>
                    <dt>{t("industry")}</dt>
                    <dd>{t(`industries.${detailTemplate.industry}`)}</dd>
                  </div>
                  <div>
                    <dt>{t("goal")}</dt>
                    <dd>{t(`goals.${detailTemplate.goal}`)}</dd>
                  </div>
                  <div>
                    <dt>{t("format")}</dt>
                    <dd>{t(`formats.${detailTemplate.format}`)}</dd>
                  </div>
                </dl>
                {requestAction(detailTemplate)}
                <p className={s.detailNote}>{t("seo.customizeNote")}</p>
              </div>
            </section>
            <section
              className={s.related}
              aria-labelledby="related-template-title"
            >
              <h2 id="related-template-title">{t("seo.relatedTitle")}</h2>
              <ul>
                {related.map(template => (
                  <li key={template.id}>
                    <Link href={getPublicTemplatePath(locale, template.id)}>
                      {getPublicTemplateText(template, "title", all)}
                    </Link>
                    <p>{getPublicTemplateText(template, "description", all)}</p>
                  </li>
                ))}
              </ul>
              <Link href={getPublicTemplatePath(locale)}>
                {t("browseAll")} <ArrowRight size={16} aria-hidden />
              </Link>
            </section>
          </>
        ) : (
          <>
            <section aria-label={t("filtersLabel")} className={s.filters}>
              <TemplateSearchForm
                key={filters.q}
                id={`${fieldsId}-search`}
                initialQuery={filters.q}
                onSearch={query => updateFilter("q", query)}
              />
              {(
                [
                  ["useCase", PUBLIC_TEMPLATE_USE_CASES],
                  ["industry", PUBLIC_TEMPLATE_INDUSTRIES],
                  ["goal", PUBLIC_TEMPLATE_GOALS],
                  ["format", PUBLIC_TEMPLATE_FORMATS],
                ] as const
              ).map(([key, values]) => (
                <div className={s.filterField} key={key}>
                  <Label htmlFor={`${fieldsId}-${key}`}>{t(key)}</Label>
                  <select
                    id={`${fieldsId}-${key}`}
                    value={filters[key]}
                    onChange={event => updateFilter(key, event.target.value)}
                  >
                    <option value="">{t(`all.${key}`)}</option>
                    {values.map(value => (
                      <option key={value} value={value}>
                        {t(
                          `${key === "industry" ? "industries" : `${key}s`}.${value}`
                        )}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </section>

            <div className={s.resultsBar}>
              <p role="status" aria-live="polite">
                {t("resultCount", { count: templates.length })}
              </p>
              {activeFilters && (
                <Button variant="ghost" size="sm" onClick={resetFilters}>
                  {t("resetFilters")}
                </Button>
              )}
            </div>
            {templates.length ? (
              <section className={s.catalog} aria-label={t("catalogLabel")}>
                {templates.map(template => {
                  const title = getPublicTemplateText(template, "title", all);
                  return (
                    <article
                      className={s.templateCard}
                      key={template.id}
                      aria-labelledby={`template-${template.id}`}
                    >
                      <TemplatePreview template={template} compact />
                      <div className={s.cardContent}>
                        <div className={s.cardMeta}>
                          <span>{t(`useCases.${template.useCase}`)}</span>
                          <span>{t(`formats.${template.format}`)}</span>
                          <span>{t(`industries.${template.industry}`)}</span>
                        </div>
                        <h2 id={`template-${template.id}`}>
                          <Link
                            href={getPublicTemplatePath(locale, template.id)}
                          >
                            {title}
                          </Link>
                        </h2>
                        <p>
                          {getPublicTemplateText(template, "description", all)}
                        </p>
                        {requestAction(template)}
                      </div>
                    </article>
                  );
                })}
              </section>
            ) : (
              <section
                className={s.empty}
                aria-labelledby="template-empty-title"
              >
                <SlidersHorizontal size={30} aria-hidden />
                <h2 id="template-empty-title">{t("emptyTitle")}</h2>
                <p>{t("emptyDescription")}</p>
                <Button variant="outline" onClick={resetFilters}>
                  {t("resetFilters")}
                </Button>
              </section>
            )}
          </>
        )}
        <nav className={s.languageLinks} aria-label={t("seo.languagesLabel")}>
          {availableLocales.map(language => (
            <Link
              key={language}
              href={getPublicTemplatePath(language, detailTemplate?.id)}
              hrefLang={PUBLIC_TEMPLATE_LANGUAGES[language].tag}
              lang={PUBLIC_TEMPLATE_LANGUAGES[language].tag}
              aria-current={language === locale ? "page" : undefined}
            >
              {PUBLIC_TEMPLATE_LANGUAGES[language].name}
            </Link>
          ))}
        </nav>
        <footer className={s.footer}>
          <span>airi.chat</span>
          <Link href="/">{t("backHome")}</Link>
          <Link href="/privacy">{t("privacyLink")}</Link>
        </footer>
      </div>
      {selectedId && (
        <TemplateRequestDialog
          templateId={selectedId}
          onClose={() => setSelectedId(null)}
          source="marketplace"
          ready={readyIds.includes(selectedId)}
          readinessLoading={loading}
          readinessUnavailable={
            unavailable || unavailableIds.includes(selectedId)
          }
        />
      )}
    </div>
  );
}
