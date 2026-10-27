import { LandingPageHeader } from "@/components/landing/page-header";
import { getLandingHeaderViewerForRequest } from "@/lib/landing/landing-header-viewer.server";
import { createMetadata } from "@/lib/seo";
import type { Metadata } from "next";

export const metadata: Metadata = createMetadata({
  title: "Security Policy",
  description: "Our approach to security, compliance, and data protection.",
  path: "/security",
  keywords: [
    "airi security policy",
    "customer data protection",
    "WhatsApp campaign platform security",
    "saas security controls",
  ],
});

export default async function SecurityPolicyPage() {
  const viewer = await getLandingHeaderViewerForRequest();

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <LandingPageHeader viewer={viewer} />
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">
          Security Policy
        </h1>
        <p className="text-muted-foreground mt-2">Last updated: 2025-01-29</p>
      </header>

      <section className="space-y-6 leading-relaxed">
        <p>
          Airi.chat is committed to protecting the confidentiality, integrity,
          and availability of customer data through layered technical and
          organizational controls.
        </p>

        <h2 className="text-xl font-medium">1. Data Protection</h2>
        <p>
          Data is encrypted in transit (TLS 1.2+) and at rest where supported by
          our providers. Access is restricted based on role and least-privilege
          principles.
        </p>

        <h2 className="text-xl font-medium">2. Multi-Tenant Data Isolation</h2>
        <p>
          Airi.chat is a multi-tenant SaaS platform. We implement strict data
          isolation to ensure that customer data is protected from unauthorized
          access by other customers:
        </p>
        <ul className="list-disc ml-6 space-y-2">
          <li>
            <span className="font-medium">Workspace-level isolation</span>: All
            queries and operations are scoped to workspace identifiers to
            prevent cross-customer data access.
          </li>
          <li>
            <span className="font-medium">Database-level controls</span>:
            Row-level security policies and application-level filtering ensure
            customers can only access their own data.
          </li>
          <li>
            <span className="font-medium">Widget analytics isolation</span>:
            Analytics data collected through our web widget is tagged with
            workspace/company identifiers and filtered at query time to ensure
            complete isolation between customers.
          </li>
          <li>
            <span className="font-medium">Authorization checks</span>: All API
            requests verify user permissions against workspace membership before
            returning data.
          </li>
        </ul>

        <h2 className="text-xl font-medium">3. Authentication and Access</h2>
        <p>
          We employ robust authentication, session management, and audit
          controls:
        </p>
        <ul className="list-disc ml-6 space-y-2">
          <li>
            <span className="font-medium">User authentication</span>: Strong
            password policies and secure session management.
          </li>
          <li>
            <span className="font-medium">Administrative access</span>:
            Protected by multi-factor authentication (MFA) and monitored through
            audit logs.
          </li>
          <li>
            <span className="font-medium">
              Role-based access control (RBAC)
            </span>
            : Internal personnel access to customer data is restricted based on
            job function and necessity.
          </li>
          <li>
            <span className="font-medium">Audit logging</span>: All data access
            by Airi.chat personnel is logged and can be reviewed upon request.
          </li>
        </ul>

        <h2 className="text-xl font-medium">4. Vulnerability Management</h2>
        <p>
          We regularly patch dependencies, monitor for vulnerabilities, and
          address issues based on severity and risk.
        </p>

        <h2 className="text-xl font-medium">5. Incident Response</h2>
        <p>
          We maintain an incident response process to detect, contain, and
          remediate security events and to notify affected parties as required
          by law.
        </p>

        <h2 className="text-xl font-medium">6. Compliance</h2>
        <p>
          We follow industry best practices and align with common standards
          relevant to our size and risk profile. Formal certifications may be
          pursued as we grow.
        </p>

        <h2 className="text-xl font-medium">
          7. Data Access by Airi.chat Personnel
        </h2>
        <p>
          Authorized Airi.chat personnel may access customer data for legitimate
          business purposes including:
        </p>
        <ul className="list-disc ml-6 space-y-2">
          <li>Platform operations and infrastructure maintenance</li>
          <li>Customer support and troubleshooting</li>
          <li>Security monitoring and incident response</li>
          <li>
            Product improvement and analytics (using aggregated, anonymized data
            where possible)
          </li>
        </ul>
        <p>
          All access is subject to strict internal policies, role-based
          permissions, and audit logging. We do not sell customer data or share
          it with third parties except as required to provide our services or as
          required by law.
        </p>

        <h2 className="text-xl font-medium">8. Contact</h2>
        <p>Report a security issue or contact us at support@airi.chat.</p>
      </section>
    </main>
  );
}
