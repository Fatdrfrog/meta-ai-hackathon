import { escapeHtml } from "@icecore/shared/lib/html-utils";

export type EmailTemplateVariables = Record<string, string | null | undefined>;

export type EmailAutomationTemplate = {
  subject: string;
  markdown: string;
};

export type RenderedEmailTemplate = {
  subject: string;
  html: string;
  text: string;
};

export const DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE: EmailAutomationTemplate =
  {
    subject: "Welcome to airi.chat",
    markdown: [
      "Hi {{userName}},",
      "",
      "Your **{{workspaceName}}** workspace is ready.",
      "",
      "Continue setup by connecting your first support channel. Once it is connected, airi.chat can start organizing conversations and surfacing follow-up opportunities.",
      "",
      "[Continue setup]({{setupUrl}})",
      "",
      "The airi.chat team",
    ].join("\n"),
  };

function cleanString(value: string | null | undefined): string {
  return String(value || "").trim();
}

// Link and image URLs are only validated here, not escaped: the HTML path
// escapes the whole markdown line before matching links, and the text path
// must keep the URL as typed. Escaping again turned "&" into "&amp;amp;".
function sanitizeHref(value: string): string {
  const raw = cleanString(value);
  if (!raw) return "#";
  if (/^\{\{\s*unsubscribeUrl\s*\}\}$/.test(raw)) {
    return "{{unsubscribeUrl}}";
  }
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("mailto:")
  ) {
    return raw;
  }
  return "#";
}

function sanitizeImageSrc(value: string): string {
  const raw = cleanString(value);
  if (!raw) return "#";
  const lower = raw.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return raw;
  }
  return "#";
}

export function applyEmailTemplateVariables(
  source: string,
  variables: EmailTemplateVariables
): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
    cleanString(variables[key])
  );
}

function renderInlineMarkdown(source: string): string {
  const escaped = escapeHtml(source);

  return escaped
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
      return `<img src="${sanitizeImageSrc(src)}" alt="${alt}" style="display:block;max-width:100%;height:auto;border:0;border-radius:8px;margin:0 0 16px;" />`;
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
      return `<a href="${sanitizeHref(href)}" style="color:#0b6bcb;text-decoration:underline;">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push(
        `<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;">${renderInlineMarkdown(
          line.slice(2).trim()
        )}</h1>`
      );
      index += 1;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push(
        `<h2 style="margin:20px 0 10px;font-size:18px;line-height:26px;">${renderInlineMarkdown(
          line.slice(3).trim()
        )}</h2>`
      );
      index += 1;
      continue;
    }

    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("- ")) {
        items.push(
          `<li style="margin:0 0 6px;">${renderInlineMarkdown(
            lines[index].trim().slice(2).trim()
          )}</li>`
        );
        index += 1;
      }
      blocks.push(
        `<ul style="margin:0 0 16px;padding-left:20px;">${items.join("")}</ul>`
      );
      continue;
    }

    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      blocks.push(
        `<p style="margin:0 0 16px;">${renderInlineMarkdown(line)}</p>`
      );
      index += 1;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("# ") &&
      !lines[index].trim().startsWith("## ") &&
      !lines[index].trim().startsWith("- ")
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    blocks.push(
      `<p style="margin:0 0 16px;">${renderInlineMarkdown(
        paragraphLines.join(" ")
      )}</p>`
    );
  }

  return blocks.join("");
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, alt, src) => `${alt} (${sanitizeImageSrc(src)})`
    )
    .replace(/^#{1,2}\s+/gm, "")
    .replace(/^\s*-\s+/gm, "- ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_match, label, href) => `${label} (${sanitizeHref(href)})`
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapEmailHtml(bodyHtml: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:24px;background:#f4f6f8;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;">
      <tbody>
        <tr>
          <td style="padding:28px;font-size:15px;line-height:24px;">
            ${bodyHtml}
          </td>
        </tr>
      </tbody>
    </table>
  </body>
</html>`;
}

export function normalizeEmailAutomationTemplate(
  input: Partial<EmailAutomationTemplate> | null | undefined
): EmailAutomationTemplate {
  const subject = cleanString(input?.subject);
  const markdown = cleanString(input?.markdown);

  return {
    subject: subject || DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE.subject,
    markdown: markdown || DEFAULT_REGISTRATION_FOLLOW_UP_TEMPLATE.markdown,
  };
}

export function renderMarkdownEmailTemplate(params: {
  subject: string;
  markdown: string;
  variables: EmailTemplateVariables;
}): RenderedEmailTemplate {
  const subject =
    applyEmailTemplateVariables(params.subject, params.variables) || "Update";
  const markdown = applyEmailTemplateVariables(
    params.markdown,
    params.variables
  );
  const bodyHtml = markdownToHtml(markdown);

  return {
    subject,
    html: wrapEmailHtml(bodyHtml),
    text: markdownToText(markdown),
  };
}
