import CompanySlugProvider from "@/components/company-slug-provider";
import { ConditionalWidgetLoader } from "@/components/conditional-widget-loader";
import ProgressProvider from "@/components/progress-provider";
import { ThemeProvider } from "@/components/settings/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  getLocaleFromCookie,
  loadRootClientMessages,
} from "@/i18n/message-loader";
import { GeistMono } from "geist/font/mono";
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { Banner } from "./banner";
import { inter } from "./fonts";
import "./globals.css";
import { cn } from "@/lib/utils";
import {
  DEFAULT_OG_IMAGE_ALT,
  DEFAULT_OG_IMAGE_HEIGHT,
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_OG_IMAGE_WIDTH,
  DEFAULT_SEO_KEYWORDS,
  getPublicBaseUrl,
} from "@/lib/public-seo";

const geistMono = GeistMono;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  applicationName: "airi.chat",
  title: {
    default: "airi.chat - WhatsApp Campaigns, AI Replies and Follow-ups",
    template: "%s - airi.chat",
  },
  description:
    "Run official WhatsApp campaigns, answer customer questions with AI, and follow up from one shared workspace. Keep your team involved at every step with airi.chat.",
  icons: {
    icon: "/logo_short_black.svg",
  },
  metadataBase: new URL(getPublicBaseUrl()),
  keywords: DEFAULT_SEO_KEYWORDS,
  openGraph: {
    title: "airi.chat - WhatsApp Campaigns, AI Replies and Follow-ups",
    description:
      "Run official WhatsApp campaigns, answer customer questions with AI, follow up automatically, and track the sales that follow.",
    url: "/",
    siteName: "airi.chat",
    images: [
      {
        url: DEFAULT_OG_IMAGE_PATH,
        width: DEFAULT_OG_IMAGE_WIDTH,
        height: DEFAULT_OG_IMAGE_HEIGHT,
        alt: DEFAULT_OG_IMAGE_ALT,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "airi.chat - WhatsApp Campaigns, AI Replies and Follow-ups",
    description:
      "WhatsApp campaigns, AI replies, follow-ups, and campaign-to-sales analytics in one workspace.",
    images: [DEFAULT_OG_IMAGE_PATH],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocaleFromCookie();
  const messages = await loadRootClientMessages(locale);

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn("h-full", inter.variable, geistMono.variable, "font-sans")}
    >
      <head>
        <link
          rel="alternate"
          type="text/plain"
          href="/llms.txt"
          title="LLM-readable summary of airi.chat"
        />
        <meta
          name="facebook-domain-verification"
          content="dtgf1pxonf4z4mdxzm9nmvsxy9qn20"
        />
      </head>
      <body className="antialiased bg-background h-full">
        <ProgressProvider>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <ThemeProvider
              attribute="class"
              defaultTheme="light"
              enableSystem
              disableTransitionOnChange
            >
              <TooltipProvider>{children}</TooltipProvider>
              <Banner />
              <Toaster />
              {/* Client-side provider to seed global company slug atom from URL */}
              <CompanySlugProvider />
            </ThemeProvider>
          </NextIntlClientProvider>
        </ProgressProvider>

        <ConditionalWidgetLoader />
      </body>
    </html>
  );
}
