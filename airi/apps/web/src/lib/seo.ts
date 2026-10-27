import {
  DEFAULT_OG_IMAGE_HEIGHT,
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_OG_IMAGE_WIDTH,
  DEFAULT_SEO_KEYWORDS,
  getPublicBaseUrl,
} from "@/lib/public-seo";
import type { Metadata } from "next";

import {
  PUBLIC_BRAND_NAME,
  PUBLIC_LEGAL_NAME,
  PUBLIC_SOCIAL_URLS,
  PUBLIC_SUPPORT_EMAIL,
} from "@/lib/airi-product-context";
function toAbsoluteUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }

  const cleanPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${getPublicBaseUrl()}${cleanPath}`;
}

/**
 * Generate canonical URL for a given path
 */
export function getCanonicalUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const baseUrl = getPublicBaseUrl();
  return `${baseUrl}${cleanPath === "/" ? "" : cleanPath}`;
}

/**
 * Generate a meta description from content, truncating to optimal length
 */
export function generateMetaDescription(
  content: string,
  maxLength: number = 160
): string {
  if (!content) return "";
  const cleaned = content.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 3) + "...";
}

/**
 * Create Organization structured data
 */
export function createOrganizationSchema() {
  const baseUrl = getPublicBaseUrl();
  const sameAs = [
    ...PUBLIC_SOCIAL_URLS,
    process.env.NEXT_PUBLIC_LINKEDIN_URL,
    process.env.NEXT_PUBLIC_X_URL,
    process.env.NEXT_PUBLIC_TELEGRAM_URL,
  ].filter((value): value is string => Boolean(value));

  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${baseUrl}/#organization`,
    name: PUBLIC_BRAND_NAME,
    legalName: PUBLIC_LEGAL_NAME,
    alternateName: ["Airi.chat", "Airi"],
    url: baseUrl,
    logo: `${baseUrl}/logo_short_black.svg`,
    description:
      "WhatsApp Business Platform campaigns, AI replies and follow-ups, and campaign-to-sales analytics for teams that sell through customer chats.",
    sameAs: Array.from(new Set(sameAs)),
    founder: [
      {
        "@type": "Person",
        name: "Aisulu Kalshabekova",
        jobTitle: "Co-Founder & CEO",
        sameAs: "https://www.linkedin.com/in/aisulu-kalshabekova-122b261b1",
      },
      {
        "@type": "Person",
        name: "Samat Kalshabekov",
        jobTitle: "Co-Founder & CTO",
        sameAs: "https://www.linkedin.com/in/kalshabekov/",
      },
    ],
    knowsAbout: [
      "WhatsApp Business Platform",
      "WhatsApp marketing automation",
      "WhatsApp Marketing Messages API",
      "WhatsApp templates and Flows",
      "Click-to-WhatsApp ads",
      "Meta Ads MCP",
      "AI follow-ups",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "Customer Support",
      email: PUBLIC_SUPPORT_EMAIL,
    },
  };
}

/**
 * Create WebSite structured data
 */
export function createWebSiteSchema() {
  const baseUrl = getPublicBaseUrl();

  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${baseUrl}/#website`,
    name: PUBLIC_BRAND_NAME,
    alternateName: ["Airi.chat", "Airi"],
    url: baseUrl,
    inLanguage: "en-US",
    description:
      "Airi.chat helps teams run official WhatsApp campaigns, answer customer questions with AI, follow up, and track the sales that follow.",
    publisher: {
      "@id": `${baseUrl}/#organization`,
    },
  };
}

/**
 * Create SoftwareApplication structured data
 */
export function createSoftwareApplicationSchema() {
  const baseUrl = getPublicBaseUrl();

  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${baseUrl}/#software`,
    name: PUBLIC_BRAND_NAME,
    alternateName: ["Airi.chat", "Airi"],
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "WhatsApp marketing automation and AI follow-ups",
    operatingSystem: "Web",
    url: baseUrl,
    description:
      "Airi.chat runs official WhatsApp campaigns with approved templates, answers customer questions with AI from the team's knowledge, follows up on replies, and reports the sales that follow each campaign.",
    featureList: [
      "Official WhatsApp bulk campaigns",
      "Marketing Messages API delivery for onboarded WhatsApp Business Accounts",
      "Pre-send checks for account readiness, opt-outs, contact frequency, and previously failed recipients",
      "WhatsApp template and Flow workflows",
      "Reply-aware AI follow-ups",
      "AI replies grounded in the team's knowledge, with handoff to the team",
      "Shared workspace for WhatsApp, Instagram, Telegram, email, and website chat",
      "Meta Ads reporting in Airi chat through Meta's Ads MCP",
      "Campaign, follow-up, and sales analytics",
    ],
    audience: {
      "@type": "Audience",
      audienceType:
        "Marketing teams, sales teams, e-commerce and retail teams, service businesses, and growth teams",
    },
    brand: {
      "@id": `${baseUrl}/#organization`,
    },
    publisher: {
      "@id": `${baseUrl}/#organization`,
    },
  };
}

/**
 * Create Article structured data
 */
export function createArticleSchema({
  title,
  description,
  publishedAt,
  modifiedAt,
  author,
  url,
  image,
}: {
  title: string;
  description?: string;
  publishedAt: string;
  modifiedAt?: string;
  author?: string;
  url: string;
  image?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: description || title,
    datePublished: publishedAt,
    dateModified: modifiedAt || publishedAt,
    author: author
      ? {
          "@type": "Person",
          name: author,
        }
      : {
          "@type": "Organization",
          name: PUBLIC_BRAND_NAME,
        },
    publisher: {
      "@type": "Organization",
      name: PUBLIC_BRAND_NAME,
      logo: {
        "@type": "ImageObject",
        url: `${getPublicBaseUrl()}/logo_short_black.svg`,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
    ...(image && {
      image: {
        "@type": "ImageObject",
        url: image,
      },
    }),
  };
}

/**
 * Create BreadcrumbList structured data
 */
export function createBreadcrumbSchema(
  items: Array<{ name: string; url: string }>
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Create FAQPage structured data
 */
export function createFAQSchema(
  faqs: Array<{ question: string; answer: string }>
) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(faq => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

/**
 * Generate metadata with SEO best practices
 */
export function createMetadata({
  title,
  description,
  keywords,
  path,
  image,
  type = "website",
  robots,
  publishedTime,
  modifiedTime,
  authors,
  languages,
  locale = "en_US",
  alternateLocales,
}: {
  title: string;
  description: string;
  keywords?: string[];
  path?: string;
  image?: string;
  type?: "website" | "article" | "profile";
  robots?: Metadata["robots"];
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
  languages?: Record<string, string>;
  locale?: string;
  alternateLocales?: string[];
}): Metadata {
  const baseUrl = getPublicBaseUrl();
  const canonical = path ? getCanonicalUrl(path) : baseUrl;
  const ogImage = toAbsoluteUrl(image || DEFAULT_OG_IMAGE_PATH);
  const defaultRobots: Metadata["robots"] = {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      noimageindex: false,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  };

  return {
    title,
    description,
    applicationName: PUBLIC_BRAND_NAME,
    creator: PUBLIC_BRAND_NAME,
    publisher: PUBLIC_BRAND_NAME,
    category: "technology",
    formatDetection: {
      email: false,
      address: false,
      telephone: false,
    },
    robots: robots || defaultRobots,
    keywords: keywords || DEFAULT_SEO_KEYWORDS,
    alternates: {
      canonical,
      ...(languages ? { languages } : {}),
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: PUBLIC_BRAND_NAME,
      images: [
        {
          url: ogImage,
          width: DEFAULT_OG_IMAGE_WIDTH,
          height: DEFAULT_OG_IMAGE_HEIGHT,
          alt: title,
        },
      ],
      locale,
      ...(alternateLocales ? { alternateLocale: alternateLocales } : {}),
      type,
      ...(type === "article" && publishedTime ? { publishedTime } : {}),
      ...(type === "article" && modifiedTime ? { modifiedTime } : {}),
      ...(type === "article" && authors && authors.length > 0
        ? { authors }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}
