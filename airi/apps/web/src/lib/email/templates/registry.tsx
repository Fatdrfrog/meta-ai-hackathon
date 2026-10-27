import React from "react";

export type PrebuiltEmailTemplateKey =
  | "announcement"
  | "product_update"
  | "event_reminder";

export type PrebuiltEmailTemplateDefinition = {
  key: PrebuiltEmailTemplateKey;
  name: string;
  description: string;
  defaultSubject: string;
};

type TemplateModel = Record<string, string>;

const TEMPLATE_DEFINITIONS: PrebuiltEmailTemplateDefinition[] = [
  {
    key: "announcement",
    name: "Announcement",
    description: "General product or business updates",
    defaultSubject: "{{company}} update",
  },
  {
    key: "product_update",
    name: "Product Update",
    description: "Feature release and rollout notices",
    defaultSubject: "New in {{company}}: {{headline}}",
  },
  {
    key: "event_reminder",
    name: "Event Reminder",
    description: "Reminder email for events, webinars, and launches",
    defaultSubject: "Reminder: {{headline}}",
  },
];

export function normalizeModel(
  input: Record<string, unknown> | null | undefined
): TemplateModel {
  const next: TemplateModel = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    next[key] = String(value);
  });
  return next;
}

export function toPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function TemplateShell(props: {
  preheader: string;
  heading: string;
  children: React.ReactNode;
  signature: string;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body
        style={{
          margin: 0,
          padding: "24px",
          fontFamily: "Arial, Helvetica, sans-serif",
          backgroundColor: "#f3f4f6",
          color: "#111827",
        }}
      >
        <div style={{ display: "none", visibility: "hidden", opacity: 0 }}>
          {props.preheader}
        </div>
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{
            maxWidth: "640px",
            margin: "0 auto",
            backgroundColor: "#ffffff",
            borderRadius: "12px",
          }}
        >
          <tbody>
            <tr>
              <td
                style={{
                  padding: "28px 28px 16px",
                  borderBottom: "1px solid #e5e7eb",
                }}
              >
                <h1 style={{ margin: 0, fontSize: "24px", lineHeight: "32px" }}>
                  {props.heading}
                </h1>
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: "20px 28px",
                  fontSize: "15px",
                  lineHeight: "24px",
                }}
              >
                {props.children}
              </td>
            </tr>
            <tr>
              <td
                style={{
                  padding: "0 28px 28px",
                  color: "#6b7280",
                  fontSize: "13px",
                }}
              >
                {props.signature}
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

function AnnouncementTemplate({ model }: { model: TemplateModel }) {
  return (
    <TemplateShell
      preheader={model.previewText || "New announcement from your team"}
      heading={model.headline || "Important update"}
      signature={model.signature || "The team"}
    >
      <p style={{ marginTop: 0 }}>Hello {model.recipientName || "there"},</p>
      <p>{model.body || "We wanted to share an important update with you."}</p>
      {model.ctaUrl ? (
        <p>
          <a
            href={model.ctaUrl}
            style={{
              display: "inline-block",
              backgroundColor: "#111827",
              color: "#ffffff",
              textDecoration: "none",
              borderRadius: "8px",
              padding: "10px 16px",
              fontWeight: 600,
            }}
          >
            {model.ctaLabel || "Learn more"}
          </a>
        </p>
      ) : null}
    </TemplateShell>
  );
}

function ProductUpdateTemplate({ model }: { model: TemplateModel }) {
  return (
    <TemplateShell
      preheader={model.previewText || "Product update"}
      heading={model.headline || "New feature available"}
      signature={model.signature || "Product team"}
    >
      <p style={{ marginTop: 0 }}>Hi {model.recipientName || "there"},</p>
      <p>
        {model.body ||
          "We just released an update that should make your workflow faster and easier."}
      </p>
      <p>
        <strong>What changed:</strong>
      </p>
      <p style={{ marginTop: 0 }}>
        {model.featureList || "- Better performance\n- Cleaner interface"}
      </p>
      {model.ctaUrl ? (
        <p>
          <a
            href={model.ctaUrl}
            style={{
              display: "inline-block",
              backgroundColor: "#0b6bcb",
              color: "#ffffff",
              textDecoration: "none",
              borderRadius: "8px",
              padding: "10px 16px",
              fontWeight: 600,
            }}
          >
            {model.ctaLabel || "Open product"}
          </a>
        </p>
      ) : null}
    </TemplateShell>
  );
}

function EventReminderTemplate({ model }: { model: TemplateModel }) {
  return (
    <TemplateShell
      preheader={model.previewText || "Upcoming event reminder"}
      heading={model.headline || "Reminder"}
      signature={model.signature || "Events team"}
    >
      <p style={{ marginTop: 0 }}>Hi {model.recipientName || "there"},</p>
      <p>
        {model.body || "This is a friendly reminder about your upcoming event."}
      </p>
      <p>
        <strong>Date:</strong> {model.eventDate || "TBD"}
        <br />
        <strong>Time:</strong> {model.eventTime || "TBD"}
      </p>
      {model.ctaUrl ? (
        <p>
          <a
            href={model.ctaUrl}
            style={{
              display: "inline-block",
              backgroundColor: "#047857",
              color: "#ffffff",
              textDecoration: "none",
              borderRadius: "8px",
              padding: "10px 16px",
              fontWeight: 600,
            }}
          >
            {model.ctaLabel || "View details"}
          </a>
        </p>
      ) : null}
    </TemplateShell>
  );
}

export function renderTemplateComponent(
  key: PrebuiltEmailTemplateKey,
  model: TemplateModel
) {
  if (key === "announcement") {
    return <AnnouncementTemplate model={model} />;
  }
  if (key === "product_update") {
    return <ProductUpdateTemplate model={model} />;
  }
  return <EventReminderTemplate model={model} />;
}

export function findPrebuiltEmailTemplate(
  key: string | null | undefined
): PrebuiltEmailTemplateDefinition | null {
  if (!key) return null;
  return TEMPLATE_DEFINITIONS.find(template => template.key === key) || null;
}
