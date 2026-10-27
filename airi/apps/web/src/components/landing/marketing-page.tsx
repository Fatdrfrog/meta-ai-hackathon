import { StructuredData } from "@/components/seo/structured-data";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/i18n/locales";
import { loadMarketingPageMessages } from "@/i18n/message-loader";
import {
  getLandingPrimaryAction,
  type LandingHeaderViewer,
} from "@/lib/landing/landing-header-viewer";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import {
  getMarketingPagePath,
  type MarketingPageId,
} from "@/lib/landing/marketing-pages";
import { getPublicTemplatePageContext } from "@/lib/landing/public-template-page-context.server";
import {
  PUBLIC_TEMPLATE_LANGUAGES,
  getPublicTemplatePath,
} from "@/lib/landing/public-template-seo";
import { BOOK_DEMO_URL } from "@/lib/links";
import { getPublicUrl } from "@/lib/public-seo";
import { createBreadcrumbSchema, createFAQSchema } from "@/lib/seo";
import { ArrowRight, CheckCheck, Plus } from "lucide-react";
import { NextIntlClientProvider } from "next-intl";
import Link from "next/link";
import { landingDisplayFont } from "./landing-display-font";
import { LandingFooter } from "./landing-footer";
import { SentAccent } from "./landing-sent-accent";
import s from "./landing-workflow-studio.module.css";
import m from "./marketing-page.module.css";
import { LandingPageHeader } from "./page-header";

type CardsSection = {
  kind: "cards";
  key: string;
  items: readonly string[];
  /** Monospace labels shown above card titles, such as MCP tool names. */
  labels?: Readonly<Record<string, string>>;
  bubbles?: boolean;
};
type TableSection = {
  kind: "table";
  key: string;
  /** Message key and the code label shown for it. */
  rows: readonly (readonly [string, string])[];
};
type StepsSection = {
  kind: "steps";
  key: string;
  items: readonly string[];
  code?: Readonly<Record<string, string>>;
  note?: boolean;
};
type NoteSection = { kind: "note"; key: string };
type Section = CardsSection | TableSection | StepsSection | NoteSection;

const MCP_URL = "https://www.airi.chat/api/mcp";

// Configuration snippets are code, so they are not translated.
const MCP_CLIENT_CONFIG = {
  claude: `claude mcp add --transport http airi ${MCP_URL} \\\n  --header "Authorization: Bearer $AIRI_API_KEY"`,
  codex: `[mcp_servers.airi]\nurl = "${MCP_URL}"\nbearer_token_env_var = "AIRI_API_KEY"`,
  cursor: `{\n  "mcpServers": {\n    "airi": {\n      "url": "${MCP_URL}",\n      "headers": { "Authorization": "Bearer \${env:AIRI_API_KEY}" }\n    }\n  }\n}`,
} as const;

const PAGE_SPECS: Record<
  MarketingPageId,
  {
    sections: readonly Section[];
    faq: readonly string[];
    related: readonly ("delivery" | "metaAds" | "mcp" | "templates")[];
    beta?: boolean;
  }
> = {
  delivery: {
    sections: [
      {
        kind: "cards",
        key: "flow",
        items: [
          "mmApi",
          "readiness",
          "audience",
          "frequency",
          "pacing",
          "pause",
          "templates",
        ],
      },
      { kind: "cards", key: "limits", items: ["perUser", "us", "optIn"] },
      {
        kind: "table",
        key: "errors",
        rows: [
          ["131049", "131049"],
          ["131050", "131050"],
          ["131026", "131026"],
          ["131047", "131047"],
          ["130429", "130429"],
          ["131042", "131042"],
          ["131063", "131063"],
          ["132000", "132000 / 132012"],
        ],
      },
      {
        kind: "steps",
        key: "steps",
        items: ["connect", "onboard", "template", "send"],
      },
    ],
    faq: ["bypass", "mmApi", "cost", "paused"],
    related: ["templates", "metaAds", "mcp"],
  },
  metaAds: {
    sections: [
      {
        kind: "cards",
        key: "ask",
        items: [
          "performance",
          "benchmarks",
          "anomalies",
          "signals",
          "opportunities",
          "history",
        ],
      },
      {
        kind: "cards",
        key: "changes",
        items: ["prepare", "confirm", "record"],
      },
      { kind: "note", key: "sales" },
      { kind: "steps", key: "steps", items: ["connect", "enable", "ask"] },
    ],
    faq: ["official", "write", "model", "whatsapp"],
    related: ["delivery", "mcp"],
  },
  mcp: {
    sections: [
      {
        kind: "cards",
        key: "tools",
        items: ["analytics", "conversations", "templates", "scenarios"],
        labels: {
          analytics: "get_analytics_summary",
          conversations: "list_conversations",
          templates: "list_whatsapp_templates",
          scenarios: "list_scenarios",
        },
      },
      {
        kind: "cards",
        key: "safety",
        items: ["readonly", "scoped", "untrusted"],
      },
      {
        kind: "steps",
        key: "connect",
        items: ["claude", "codex", "cursor"],
        code: MCP_CLIENT_CONFIG,
        note: true,
      },
      {
        kind: "cards",
        key: "examples",
        items: ["channels", "open", "trend"],
        bubbles: true,
      },
    ],
    faq: ["send", "clients", "limits", "meta"],
    related: ["metaAds", "delivery"],
    beta: true,
  },
};

type MessageTree = { [key: string]: string | MessageTree };

function createText(tree: MessageTree, prefix: string) {
  return (path: string): string => {
    const value = `${prefix}.${path}`
      .split(".")
      .reduce<
        string | MessageTree | undefined
      >((node, key) => (node && typeof node === "object" ? node[key] : undefined), tree);
    if (typeof value !== "string") {
      throw new Error(`Missing marketing page message: ${prefix}.${path}`);
    }
    return value;
  };
}

function primaryActionLabel(
  viewer: LandingHeaderViewer | null | undefined,
  translate: (key: string) => string
) {
  const { label } = getLandingPrimaryAction(viewer ?? undefined);
  if (label === "openWorkspace")
    return translate("LandingPage.header.openWorkspace");
  if (label === "signIn") return translate("LandingDemo.header.signIn");
  return translate("LandingDemo.hero.startFree");
}

export async function getMarketingPageText(locale: Locale) {
  const messages = (await loadMarketingPageMessages(locale)) as MessageTree;
  return createText(messages, "MarketingPages");
}

export async function MarketingPage({
  page,
  locale,
}: {
  page: MarketingPageId;
  locale: Locale;
}) {
  const [viewer, { translate, messages }, text] = await Promise.all([
    getLandingHeaderViewerForRequest(),
    getPublicTemplatePageContext(locale),
    getMarketingPageText(locale),
  ]);
  const spec = PAGE_SPECS[page];
  const t = (path: string) => text(`${page}.${path}`);
  const primaryAction = getLandingPrimaryAction(viewer ?? undefined);
  const actionLabel = primaryActionLabel(viewer, translate);
  const url = getPublicUrl(getMarketingPagePath(page, locale));
  const faqItems = spec.faq.map(key => ({
    key,
    question: t(`faq.items.${key}.question`),
    answer: t(`faq.items.${key}.answer`),
  }));
  const relatedHref = (target: (typeof spec.related)[number]) =>
    target === "templates"
      ? getPublicTemplatePath(locale)
      : getMarketingPagePath(target, locale);

  return (
    <main
      lang={PUBLIC_TEMPLATE_LANGUAGES[locale].tag}
      className={`min-h-screen bg-background ${landingDisplayFont.variable}`}
    >
      <StructuredData
        data={[
          {
            "@context": "https://schema.org",
            "@type": "WebPage",
            "@id": `${url}#page`,
            url,
            name: t("seo.title"),
            description: t("seo.description"),
            inLanguage: PUBLIC_TEMPLATE_LANGUAGES[locale].tag,
            isPartOf: { "@id": `${getPublicUrl()}/#website` },
          },
          createBreadcrumbSchema([
            { name: "airi.chat", url: getPublicUrl() },
            { name: t("seo.title"), url },
          ]),
          createFAQSchema(faqItems),
        ]}
      />
      <NextIntlClientProvider locale={locale} messages={messages}>
        <div className={s.root}>
          <LandingPageHeader
            viewer={viewer ?? undefined}
            languageSwitcherActiveLocale={locale}
            languageSwitcherSyncSearchParam
          />

          <section className={m.hero} aria-labelledby="marketing-page-title">
            <div className={m.heroInner}>
              <p className={m.eyebrow}>
                {t("hero.eyebrow")}
                {spec.beta ? (
                  <span className={m.badge}>{text("common.beta")}</span>
                ) : null}
              </p>
              <h1 id="marketing-page-title" className={m.title}>
                {t("hero.title")}{" "}
                <span className={s.headingAccent}>
                  <SentAccent text={t("hero.accent")} />
                </span>
              </h1>
              <p className={m.lead}>{t("hero.lead")}</p>
              <div className={m.actions}>
                <Button
                  asChild
                  size="lg"
                  variant="secondary"
                  className={s.primaryAction}
                >
                  <Link href={primaryAction.href}>{actionLabel}</Link>
                </Button>
                {!viewer?.isAuthenticated ? (
                  <a
                    className={s.textButton}
                    href={BOOK_DEMO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {translate("LandingDemo.hero.bookDemo")}
                    <ArrowRight size={17} aria-hidden />
                  </a>
                ) : null}
              </div>
            </div>
          </section>

          {spec.sections.map((section, index) => {
            const id = `${page}-${section.key}`;
            const tinted = index % 2 === 0;
            const sectionClass = [
              m.section,
              section.kind === "note" ? m.noteBand : tinted ? m.tinted : "",
            ].join(" ");
            return (
              <section
                key={section.key}
                id={section.key}
                className={sectionClass}
                aria-labelledby={`${id}-title`}
              >
                <div className={s.sectionInner}>
                  <div className={s.sectionHeading}>
                    <h2 id={`${id}-title`} className={m.sectionTitle}>
                      {t(`${section.key}.title`)}
                    </h2>
                    <p className={s.sectionIntro}>
                      {t(`${section.key}.intro`)}
                    </p>
                  </div>

                  {section.kind === "cards" ? (
                    <ul
                      className={[
                        m.cardGrid,
                        section.bubbles ? m.bubbles : "",
                      ].join(" ")}
                    >
                      {section.items.map(item => (
                        <li key={item} className={m.card}>
                          {section.labels?.[item] ? (
                            <code className={m.cardLabel}>
                              {section.labels[item]}
                            </code>
                          ) : null}
                          <h3>{t(`${section.key}.items.${item}.title`)}</h3>
                          <p>{t(`${section.key}.items.${item}.body`)}</p>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {section.kind === "table" ? (
                    <div className={m.tableWrap}>
                      <table className={m.table}>
                        <thead>
                          <tr>
                            <th scope="col">
                              {t(`${section.key}.columns.code`)}
                            </th>
                            <th scope="col">
                              {t(`${section.key}.columns.meaning`)}
                            </th>
                            <th scope="col">
                              {t(`${section.key}.columns.action`)}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {section.rows.map(([row, code]) => (
                            <tr key={row}>
                              <th scope="row">
                                <code>{code}</code>
                              </th>
                              <td
                                data-label={t(`${section.key}.columns.meaning`)}
                              >
                                {t(`${section.key}.rows.${row}.meaning`)}
                              </td>
                              <td
                                data-label={t(`${section.key}.columns.action`)}
                              >
                                {t(`${section.key}.rows.${row}.action`)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {section.kind === "steps" ? (
                    <>
                      <ol className={m.steps}>
                        {section.items.map((item, step) => (
                          <li key={item} className={m.step}>
                            <span className={m.stepNumber} aria-hidden>
                              {step + 1}
                            </span>
                            <div className={m.stepBody}>
                              <h3>{t(`${section.key}.items.${item}.title`)}</h3>
                              <p>{t(`${section.key}.items.${item}.body`)}</p>
                              {section.code?.[item] ? (
                                <pre
                                  className={m.code}
                                  aria-label={`${t(`${section.key}.items.${item}.title`)}: ${text("common.codeLabel")}`}
                                  tabIndex={0}
                                >
                                  <code>{section.code[item]}</code>
                                </pre>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                      {section.note ? (
                        <p className={m.note}>{t(`${section.key}.note`)}</p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </section>
            );
          })}

          <section
            className={s.editorialSection}
            aria-labelledby={`${page}-faq-title`}
          >
            <div className={[s.sectionInner, s.faqLayout].join(" ")}>
              <div className={s.sectionHeading}>
                <h2 id={`${page}-faq-title`} className={m.sectionTitle}>
                  {text("common.faqTitle")}
                </h2>
                <p className={s.sectionIntro}>{t("faq.intro")}</p>
              </div>
              <div className={s.faqList}>
                {faqItems.map((item, index) => (
                  <details
                    key={item.key}
                    name={`${page}-faq`}
                    open={index === 0}
                  >
                    <summary>
                      <span>{item.question}</span>
                      <CheckCheck
                        className={s.faqTicks}
                        size={16}
                        aria-hidden
                      />
                      <Plus size={20} aria-hidden />
                    </summary>
                    <p>{item.answer}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>

          <nav className={m.related} aria-labelledby={`${page}-related-title`}>
            <div className={s.sectionInner}>
              <h2 id={`${page}-related-title`} className={m.relatedTitle}>
                {text("common.related")}
              </h2>
              <ul className={m.relatedLinks}>
                {spec.related.map(target => (
                  <li key={target}>
                    <Link href={relatedHref(target)}>
                      {translate(`LandingDemo.footer.${target}`)}
                      <ArrowRight size={16} aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <section
            className={s.finalCta}
            aria-labelledby={`${page}-start-title`}
          >
            <div className={s.sectionInner}>
              <h2 id={`${page}-start-title`}>
                {t("cta.title")}{" "}
                <em>
                  <SentAccent text={t("cta.accent")} />
                </em>
              </h2>
              <p>{t("cta.body")}</p>
              <div className={s.finalActions}>
                <Button asChild variant="secondary" className={s.primaryAction}>
                  <Link href={primaryAction.href}>
                    {actionLabel}
                    <ArrowRight size={17} aria-hidden />
                  </Link>
                </Button>
              </div>
            </div>
          </section>

          <LandingFooter />
        </div>
      </NextIntlClientProvider>
    </main>
  );
}
