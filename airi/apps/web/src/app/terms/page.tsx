import { LandingPageHeader } from "@/components/landing/page-header";
import {
  PUBLIC_LEGAL_ENTITY_TYPE,
  PUBLIC_LEGAL_NAME,
  PUBLIC_LEGAL_REGISTERED_ADDRESS,
  PUBLIC_LEGAL_REGISTRATION_LABEL,
  PUBLIC_LEGAL_REGISTRATION_NUMBER,
  PUBLIC_SUPPORT_EMAIL,
} from "@/lib/airi-product-context";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import { createMetadata } from "@/lib/seo";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = createMetadata({
  title: "Terms of Service",
  description: "Legal terms and conditions for using Airi.chat.",
  path: "/terms",
  keywords: [
    "airi terms of service",
    "saas legal terms",
    "WhatsApp campaign terms",
    "customer engagement software agreement",
  ],
});

export default async function TermsOfServicePage() {
  const viewer = await getLandingHeaderViewerForRequest();

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <LandingPageHeader viewer={viewer} />
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          Terms of Service
        </h1>
        <p className="text-muted-foreground mt-2">Last updated: 2026-10-21</p>
      </header>

      <section className="space-y-8 leading-relaxed">
        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) govern access to and
          use of Airi.chat&rsquo;s business-to-business software-as-a-service
          platform for WhatsApp bulk campaigns, customer engagement workflows,
          AI-assisted follow-ups, and conversation analytics (the
          &ldquo;Service&rdquo;). Airi.chat is operated by {PUBLIC_LEGAL_NAME},{" "}
          a {PUBLIC_LEGAL_ENTITY_TYPE}. References to &ldquo;Airi.chat,&rdquo;
          &ldquo;we,&rdquo; &ldquo;us,&rdquo; and &ldquo;our&rdquo; mean this
          legal entity unless the context requires otherwise. If you accept on
          behalf of a company or other legal entity, you represent that you have
          authority to bind such entity; in that case, &ldquo;Customer,&rdquo;
          &ldquo;you,&rdquo; or &ldquo;your&rdquo; refers to that entity.
        </p>

        <h2 className="text-xl font-medium">1. Provider Information</h2>
        <dl className="space-y-3">
          <div>
            <dt className="font-medium">Legal entity</dt>
            <dd>{PUBLIC_LEGAL_NAME}</dd>
          </div>
          <div>
            <dt className="font-medium">Entity type</dt>
            <dd>{PUBLIC_LEGAL_ENTITY_TYPE}</dd>
          </div>
          <div>
            <dt className="font-medium">{PUBLIC_LEGAL_REGISTRATION_LABEL}</dt>
            <dd>{PUBLIC_LEGAL_REGISTRATION_NUMBER}</dd>
          </div>
          <div>
            <dt className="font-medium">Registered address</dt>
            <dd>{PUBLIC_LEGAL_REGISTERED_ADDRESS}</dd>
          </div>
          <div>
            <dt className="font-medium">Support contact</dt>
            <dd>
              <a className="underline" href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}>
                {PUBLIC_SUPPORT_EMAIL}
              </a>
            </dd>
          </div>
        </dl>

        <h2 className="text-xl font-medium">
          2. Order Forms; Subscription Term
        </h2>
        <p>
          The Service is provided on a subscription basis as set out on an
          applicable online order page or mutually executed order form (each, an
          &ldquo;Order Form&rdquo;). The Subscription Term, plan tier, usage
          allotments, permitted users, and pricing are specified on the Order
          Form. Unless otherwise stated, subscriptions renew automatically for
          successive terms equal to the initial Subscription Term unless
          cancelled prior to renewal.
        </p>

        <h2 className="text-xl font-medium">3. Access and Use</h2>
        <ul className="list-disc ml-6 space-y-2">
          <li>
            <span className="font-medium">License.</span> Subject to these Terms
            and timely payment of fees, Airi.chat grants Customer a limited,
            non-exclusive, non-transferable license to access and use the
            Service during the Subscription Term solely for Customer&rsquo;s
            internal business purposes.
          </li>
          <li>
            <span className="font-medium">Accounts.</span> Customer is
            responsible for all activity under its accounts and must maintain
            the confidentiality of credentials and implement commercially
            reasonable security controls.
          </li>
        </ul>

        <h2 className="text-xl font-medium">4. Fees; Taxes</h2>
        <p>
          Fees are billed as specified on the Order Form. Overage fees apply for
          usage beyond plan allotments. All fees are exclusive of taxes;
          Customer is responsible for applicable sales, use, VAT, and similar
          taxes (excluding taxes based on Airi.chat&rsquo;s net income).
          Refunds, cancellations, and unused-day recalculations are handled
          according to our{" "}
          <Link className="underline" href="/refunds">
            Refund Policy
          </Link>
          , applicable law, and any applicable Order Form.
        </p>
        <p>
          For purchases processed through Paddle, our order process is conducted
          by our online reseller Paddle.com. Paddle.com is the merchant of
          record for those orders. Paddle provides customer service inquiries
          and handles returns for Paddle-processed transactions.
        </p>

        <h2 className="text-xl font-medium">5. Customer Data; Privacy</h2>
        <p>
          &ldquo;Customer Data&rdquo; means data submitted to or collected by
          the Service from Customer&apos;s systems, sources, or users. As
          between the parties, Customer retains all right, title, and interest
          in Customer Data. Airi.chat processes Customer Data solely to provide
          the Service, to maintain and secure the Service, and as otherwise
          permitted in these Terms and our{" "}
          <Link className="underline" href="/privacy">
            Privacy Policy
          </Link>
          . Where required, the parties may execute a data processing addendum
          (DPA).
        </p>
        <h3 className="text-lg font-medium mt-4">
          Widget Analytics Data Collection
        </h3>
        <p>
          When Customer installs Airi.chat&apos;s web chat widget on
          Customer&apos;s website, the Service automatically collects analytics
          data from Customer&apos;s website visitors, including but not limited
          to: pageviews, session durations, device types, traffic sources,
          visitor behavior, and conversation metrics. Customer acknowledges and
          agrees that:
        </p>
        <ul className="list-disc ml-6 space-y-2">
          <li>
            <span className="font-medium">Data Collection.</span> Airi.chat
            collects and processes widget analytics data to provide Customer
            with analytics dashboards, improve platform performance, provide
            customer support, and enhance the Service.
          </li>
          <li>
            <span className="font-medium">Data Isolation.</span> Customer&apos;s
            widget analytics data is isolated from other customers&apos; data.
            Airi.chat implements technical and organizational measures to ensure
            multi-tenant data isolation.
          </li>
          <li>
            <span className="font-medium">Airi.chat Access.</span> Authorized
            Airi.chat personnel may access Customer&apos;s widget analytics data
            for platform operations, debugging, security monitoring, customer
            support, and product improvement. Airi.chat implements role-based
            access controls and audit logging for all data access.
          </li>
          <li>
            <span className="font-medium">Aggregate Use.</span> Airi.chat may
            use aggregated, anonymized widget analytics data across all
            customers for product analytics, platform optimization, and business
            intelligence, provided that individual customer data is not
            identifiable in such aggregations.
          </li>
          <li>
            <span className="font-medium">No Sale.</span> Airi.chat will not
            sell Customer&apos;s widget analytics data or share it with third
            parties except as required to provide the Service (e.g., analytics
            infrastructure providers) or as required by law.
          </li>
          <li>
            <span className="font-medium">Customer Responsibility.</span>{" "}
            Customer is responsible as the data controller for ensuring it has
            appropriate legal bases under applicable privacy laws (including
            GDPR, CCPA) to collect data from its website visitors through the
            widget.
          </li>
        </ul>

        <h2 className="text-xl font-medium">
          6. Security; Availability; Support
        </h2>
        <ul className="list-disc ml-6 space-y-2">
          <li>
            Airi.chat will implement reasonable administrative, technical, and
            physical security measures to protect Customer Data.
          </li>
          <li>
            Airi.chat will use commercially reasonable efforts to provide high
            availability of the Service, excluding planned maintenance and
            factors outside our reasonable control.
          </li>
          <li>
            Standard support is included with paid plans; premium support may be
            purchased separately.
          </li>
        </ul>

        <h2 className="text-xl font-medium">7. Acceptable Use</h2>
        <p>
          Customer will not: (a) use the Service for unlawful, infringing,
          harmful, or abusive purposes; (b) attempt to gain unauthorized access
          to the Service or underlying systems; (c) probe or scan for
          vulnerabilities without prior written consent; (d) reverse engineer,
          decompile, or attempt to derive source code; (e) interfere with or
          disrupt the Service; or (f) exceed permitted usage or circumvent
          technical controls.
        </p>

        <h2 className="text-xl font-medium">8. Third-Party Services</h2>
        <p>
          The Service works with third-party platforms that Customer connects,
          such as the WhatsApp Business Platform, Instagram, Telegram, Meta Ads,
          and Canva. Customer&rsquo;s use of those platforms is governed by
          their providers&rsquo; terms and policies, including Meta&rsquo;s
          WhatsApp Business terms and messaging policies. By connecting a
          platform, Customer authorizes Airi.chat to receive its webhooks and to
          call its APIs as necessary to provide the Service.
        </p>
        <p>
          Airi.chat sends messages, submits message templates, or changes ad
          settings only when Customer, or a configuration Customer sets up (such
          as a campaign, a scenario, or AI replies), directs it to. Changes to
          Meta Ads campaigns require Customer&rsquo;s confirmation. Customer is
          responsible for obtaining any consent or opt-in its recipients must
          give to receive messages, and for fees charged by those platforms,
          such as Meta&rsquo;s WhatsApp messaging charges, which are billed
          separately.
        </p>

        <h2 className="text-xl font-medium">
          9. Intellectual Property; Feedback
        </h2>
        <p>
          Airi.chat and its licensors own all rights in and to the Service and
          related materials. No rights are granted except as expressly stated.
          By providing feedback, Customer grants Airi.chat a worldwide,
          royalty-free, perpetual license to use and incorporate feedback
          without restriction.
        </p>

        <h2 className="text-xl font-medium">10. Confidentiality</h2>
        <p>
          Each party may receive non-public information from the other that is
          identified as confidential or should reasonably be understood to be
          confidential (&ldquo;Confidential Information&rdquo;). The receiving
          party will use Confidential Information only to exercise its rights
          and perform obligations under these Terms and will protect it using
          reasonable care.
        </p>

        <h2 className="text-xl font-medium">11. Suspension; Termination</h2>
        <p>
          Airi.chat may suspend access for non-payment, security risks, or
          violations of these Terms. Either party may terminate upon material
          breach that remains uncured for 30 days after notice. Upon
          termination, Customer&rsquo;s access ceases and Airi.chat will delete
          or return Customer Data in accordance with our data retention
          policies, except where retention is required by law.
        </p>

        <h2 className="text-xl font-medium">12. Warranties; Disclaimers</h2>
        <p>
          Airi.chat warrants that it will provide the Service in a professional
          and workmanlike manner. EXCEPT AS EXPRESSLY STATED, THE SERVICE IS
          PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo;, AND
          Airi.chat DISCLAIMS ALL IMPLIED WARRANTIES, INCLUDING MERCHANTABILITY,
          FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
        </p>

        <h2 className="text-xl font-medium">13. Indemnification</h2>
        <p>
          Customer will defend and indemnify Airi.chat against third-party
          claims arising from Customer Data, Customer&rsquo;s use of the Service
          in violation of these Terms, or Customer&rsquo;s violation of law.
          Airi.chat will provide prompt notice and reasonable cooperation.
        </p>

        <h2 className="text-xl font-medium">14. Limitation of Liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL Airi.chat BE
          LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, COVER, OR
          PUNITIVE DAMAGES, OR LOSS OF PROFITS, REVENUE, DATA, OR BUSINESS, EVEN
          IF ADVISED OF THE POSSIBILITY. Airi.chat&rsquo;s AGGREGATE LIABILITY
          ARISING OUT OF OR RELATED TO THE SERVICE WILL NOT EXCEED THE AMOUNT
          PAID BY CUSTOMER FOR THE SERVICE IN THE TWELVE (12) MONTHS PRECEDING
          THE EVENT GIVING RISE TO LIABILITY.
        </p>

        <h2 className="text-xl font-medium">
          15. Modifications to the Service and Terms
        </h2>
        <p>
          Airi.chat may modify features or functions of the Service, provided
          such changes do not materially reduce core functionality during a
          paid, current Subscription Term. Airi.chat may update these Terms from
          time to time; material changes will be communicated by updating the
          date above and/or reasonable notice through the Service.
        </p>

        <h2 className="text-xl font-medium">
          16. Governing Law; Dispute Resolution
        </h2>
        <p>
          These Terms are governed by the laws of the Republic of Kazakhstan,
          without regard to conflict of law principles. The parties will attempt
          to resolve disputes through good faith negotiations. Failing that, the
          dispute will be resolved by the competent courts located in Astana,
          Republic of Kazakhstan, and the parties consent to such jurisdiction
          and venue to the extent permitted by applicable law. The United
          Nations Convention on Contracts for the International Sale of Goods
          does not apply.
        </p>

        <h2 className="text-xl font-medium">17. Publicity</h2>
        <p>
          During the Subscription Term, Airi.chat may use Customer&rsquo;s name
          and logo on our website and marketing materials to identify Customer
          as a customer, consistent with Customer&rsquo;s brand guidelines.
          Customer may opt out by notifying us in writing.
        </p>

        <h2 className="text-xl font-medium">18. Miscellaneous</h2>
        <p>
          These Terms constitute the entire agreement between the parties
          regarding the subject matter and supersede prior or contemporaneous
          agreements. If any provision is held unenforceable, the remaining
          provisions remain in full force. Neither party may assign these Terms
          without the other&rsquo;s consent, except to an affiliate or in
          connection with a merger, acquisition, or sale of substantially all
          assets.
        </p>

        <h2 className="text-xl font-medium">19. Contact</h2>
        <p>
          Questions about these Terms? Contact us at{" "}
          <a className="underline" href={`mailto:${PUBLIC_SUPPORT_EMAIL}`}>
            {PUBLIC_SUPPORT_EMAIL}
          </a>
          . Legal notices may also be sent to the registered address listed
          above.
        </p>
      </section>
    </main>
  );
}
