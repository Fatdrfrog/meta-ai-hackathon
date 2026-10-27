import { LandingPageHeader } from "@/components/landing/page-header";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import { createMetadata } from "@/lib/seo";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = createMetadata({
  title: "Privacy Policy",
  description: "How Airi.chat collects, uses, and protects personal data.",
  path: "/privacy",
  keywords: [
    "airi privacy policy",
    "customer data privacy",
    "WhatsApp campaign privacy",
    "ccpa compliance policy",
  ],
});

export default async function PrivacyPolicyPage() {
  const viewer = await getLandingHeaderViewerForRequest();

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <LandingPageHeader viewer={viewer} />
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          Privacy Policy
        </h1>
        <p className="text-muted-foreground mt-2">Last updated: 2026-10-21</p>
      </header>

      <section className="space-y-6 leading-relaxed">
        <p>
          This Privacy Policy explains how Airi.chat (&ldquo;Airi.chat&ldquo;,
          &ldquo;we&ldquo;, &ldquo;us&ldquo;) collects, uses, discloses, and
          protects information about you when you use our services, websites,
          and integrations (the &ldquo;Service&ldquo;). This policy is designed
          to meet requirements of the EU/UK GDPR and US state privacy laws
          (including California CCPA/CPRA) where applicable.
        </p>

        <h2 className="text-xl font-medium">
          1. Who We Are and How to Contact Us
        </h2>
        <p>
          Airi.chat is the controller of your personal data when we determine
          the purposes and means of processing. If you have questions or wish to
          exercise your rights, contact us at{" "}
          <Link className="underline" href="mailto:support@airi.chat">
            support@airi.chat
          </Link>
          .
        </p>

        <h2 className="text-xl font-medium">2. Information We Collect</h2>
        <p>We collect the following categories of information:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <span className="font-medium">Account and profile</span>: name,
            email, company, role, workspace details.
          </li>
          <li>
            <span className="font-medium">Service content</span>: conversations
            and messages you ingest or connect via integrations.
          </li>
          <li>
            <span className="font-medium">Usage and device</span>: log data, IP
            address, browser, device identifiers, pages viewed.
          </li>
          <li>
            <span className="font-medium">Integrations data</span>: data we
            receive from platforms you connect (such as the WhatsApp Business
            Platform, Instagram, Telegram, Meta Ads, and Canva) per your
            configuration.
          </li>
          <li>
            <span className="font-medium">Widget analytics data</span>: When you
            install our chat widget on your website, we collect analytics data
            including pageviews, session durations, device types, traffic
            sources, and conversation metrics from your website visitors. This
            data is used to provide you with analytics dashboards and improve
            our services.
          </li>
          <li>
            <span className="font-medium">
              Cookies and similar technologies
            </span>
            : used for authentication, analytics, and preferences (see
            &quot;Cookies&quot; below).
          </li>
          <li>
            <span className="font-medium">Support and communications</span>:
            feedback, requests, and email or in-product messages.
          </li>
        </ul>

        <h2 className="text-xl font-medium">
          3. Purposes and Legal Bases (EU/UK GDPR)
        </h2>
        <p>
          We process personal data for the following purposes and legal bases:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <span className="font-medium">
              Provide and maintain the Service
            </span>{" "}
            (perform a contract or take steps at your request).
          </li>
          <li>
            <span className="font-medium">Secure and protect the Service</span>{" "}
            (legitimate interests; compliance with legal obligations).
          </li>
          <li>
            <span className="font-medium">Improve and develop features</span>{" "}
            (legitimate interests; we balance against your interests and
            rights).
          </li>
          <li>
            <span className="font-medium">Communicate with you</span>{" "}
            (legitimate interests for product updates; consent where required
            for marketing).
          </li>
          <li>
            <span className="font-medium">Analytics and research</span>{" "}
            (legitimate interests, using aggregated or de-identified data where
            possible).
          </li>
          <li>
            <span className="font-medium">Comply with law</span> (legal
            obligations).
          </li>
        </ul>
        <p>
          Where we rely on consent, you can withdraw it at any time. Where we
          rely on legitimate interests, you have the right to object.
        </p>

        <h2 className="text-xl font-medium">4. Sharing of Information</h2>
        <p>We share information with:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <span className="font-medium">Service providers</span> who assist
            with hosting, storage, analytics, security, email, and support.
          </li>
          <li>
            <span className="font-medium">Integrated platforms</span> at your
            direction when you connect third-party tools.
          </li>
          <li>
            <span className="font-medium">Legal and compliance</span> recipients
            when required by law or to protect rights, safety, and security.
          </li>
          <li>
            <span className="font-medium">Business transfers</span> in
            connection with a merger, acquisition, or asset sale.
          </li>
        </ul>
        <p>We do not sell personal data.</p>

        <h2 className="text-xl font-medium">5. International Transfers</h2>
        <p>
          If we transfer personal data outside your country (including from the
          EEA/UK to other countries), we rely on appropriate safeguards such as
          Standard Contractual Clauses and additional measures where necessary.
        </p>

        <h2 className="text-xl font-medium">6. Data Retention</h2>
        <p>
          We retain personal data for as long as needed to provide the Service,
          comply with legal obligations, resolve disputes, and enforce
          agreements. Retention periods may vary by data category and your
          configuration.
        </p>

        <h2 className="text-xl font-medium">7. Security</h2>
        <p>
          We implement technical and organizational measures to protect
          information. Learn more in our{" "}
          <Link className="underline" href="/security">
            Security Policy
          </Link>
          .
        </p>

        <h2 className="text-xl font-medium">8. Your Rights (EU/UK)</h2>
        <p>
          Subject to conditions and exceptions, you have rights to access,
          rectify, erase, restrict processing, data portability, and object to
          processing. You may also withdraw consent at any time. You have the
          right to lodge a complaint with your local supervisory authority.
        </p>

        <h2 className="text-xl font-medium">
          9. Your Rights (US State Laws incl. CCPA/CPRA)
        </h2>
        <p>
          Depending on your state, you may have rights to know/access, delete,
          correct, and obtain a portable copy of your information; to opt out of{" "}
          <span className="italic">sale</span>,
          <span className="italic">sharing</span>, or{" "}
          <span className="italic">targeted advertising</span>; and to limit the
          use/disclosure of sensitive personal information. We do not
          discriminate against you for exercising these rights.
        </p>
        <p>
          To exercise rights, email{" "}
          <a className="underline" href="mailto:support@airi.chat">
            support@airi.chat
          </a>
          . If we deny a request, you may appeal by replying to our decision
          with “Appeal” in the subject line. You can opt out of marketing emails
          via the unsubscribe link in our emails.
        </p>

        <h2 className="text-xl font-medium">10. Cookies and Tracking</h2>
        <p>
          We use cookies and similar technologies for authentication,
          preferences, analytics, and security. You can control cookies through
          your browser settings. Some features may not function properly without
          certain cookies.
        </p>

        <h2 className="text-xl font-medium">11. Children’s Privacy</h2>
        <p>
          The Service is not directed to children and we do not knowingly
          collect personal data from children. If you believe a child has
          provided us information, contact us to delete it.
        </p>

        <h2 className="text-xl font-medium">12. Automated Processing</h2>
        <p>
          We use automated processing, including AI models, to answer your
          customers&apos; messages when you turn on AI replies, to help prepare
          campaigns and follow-ups, and to analyze conversations. You decide
          where AI replies are used, and your team can take over a conversation
          at any time. We do not make decisions based solely on automated
          processing that produce legal or similarly significant effects.
        </p>

        <h2 className="text-xl font-medium">13. Changes to This Policy</h2>
        <p>
          We may update this policy from time to time. Material changes will be
          communicated by updating the date above or via in-product notices.
        </p>

        <h2 className="text-xl font-medium">14. Contact</h2>
        <p>
          Questions or requests? Contact us at{" "}
          <a className="underline" href="mailto:support@airi.chat">
            support@airi.chat
          </a>
          .
        </p>

        <h2 className="text-xl font-medium">15. AI Model Training</h2>
        <p>
          We do not use your personal information to train generalized AI
          models. We may use aggregated or de-identified data to improve
          features and performance.
        </p>

        <h2 className="text-xl font-medium">16. Do Not Track</h2>
        <p>
          Some browsers offer a “Do Not Track” (DNT) setting. We currently do
          not respond to DNT signals. You can manage cookies and similar
          technologies via your browser settings.
        </p>

        <h2 className="text-xl font-medium">17. Third-Party Links</h2>
        <p>
          The Service may contain links to third-party websites or services. We
          are not responsible for their privacy practices. We encourage you to
          review the privacy policies of those third parties.
        </p>

        <h2 className="text-xl font-medium">
          18. Service Providers and AI Vendors
        </h2>
        <p>
          We use service providers to host, deliver, and support the Service,
          including Vercel (web hosting and CDN), Google Cloud (background
          processing, message queues, file storage, and realtime delivery),
          Supabase (authentication, database, and file storage), MongoDB Atlas
          (conversation and message storage), Temporal (scheduling campaigns and
          follow-ups), Upstash (rate limiting and caching), Postmark (account
          emails), PostHog (product analytics and session recordings), Paddle
          (payments, as merchant of record), and LiveKit (WhatsApp calls, when
          used).
        </p>
        <p>
          For AI features, we send the inputs a request needs, after applying
          safeguards such as PII redaction where possible, to AI providers:
          Anthropic (Claude) for text, and Google (Gemini) for embeddings, media
          understanding, and as a fallback. When your workspace uses voice,
          image, or video generation, the relevant inputs go to ElevenLabs,
          Higgsfield, Bria, or HappyHorse. We do not authorize providers to use
          your data to train generalized models.
        </p>

        <h2 className="text-xl font-medium">
          19. Widget Analytics and Data Access
        </h2>
        <p>
          When you install our web chat widget on your website, we collect and
          process analytics data from your website visitors including pageviews,
          session information, device types, traffic sources, and conversation
          metrics. This data is:
        </p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <span className="font-medium">Isolated by workspace</span>: Your
            analytics data is completely isolated from other customers&apos;
            data. You only see analytics from your own widget installations.
          </li>
          <li>
            <span className="font-medium">Used to provide services</span>: We
            use this data to generate analytics dashboards for you, improve
            platform performance, and provide customer support.
          </li>
          <li>
            <span className="font-medium">
              Accessible by Airi.chat personnel
            </span>
            : Authorized Airi.chat personnel may access your widget analytics
            data for platform operations, debugging, support, security
            monitoring, and product improvement. We implement strict access
            controls and audit logging for all data access.
          </li>
          <li>
            <span className="font-medium">Not sold or shared</span>: We do not
            sell your widget analytics data or share it with third parties
            except as required to provide our services (e.g., hosting on our
            analytics provider&apos;s infrastructure).
          </li>
          <li>
            <span className="font-medium">Used for aggregate insights</span>: We
            may use aggregated, anonymized analytics data across all customers
            to improve our product and services, but individual customer data is
            never exposed in such aggregations.
          </li>
        </ul>
        <p>
          By installing our widget, you acknowledge that Airi.chat will collect
          and process this analytics data as described. You remain the
          controller of this data under GDPR and are responsible for ensuring
          you have appropriate legal bases (such as consent or legitimate
          interests) to collect data from your website visitors.
        </p>
      </section>
    </main>
  );
}
