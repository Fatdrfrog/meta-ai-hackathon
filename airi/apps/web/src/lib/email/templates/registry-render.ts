import {
  findPrebuiltEmailTemplate,
  normalizeModel,
  renderTemplateComponent,
  toPlainText,
  type PrebuiltEmailTemplateKey,
} from "./registry";

function applyTemplateVariables(
  source: string,
  model: Record<string, string>
): string {
  return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const raw = model[key];
    return raw && raw.trim().length > 0 ? raw.trim() : "";
  });
}

export async function renderPrebuiltCampaignEmail(params: {
  templateKey: PrebuiltEmailTemplateKey;
  templateModel?: Record<string, unknown>;
  subjectOverride?: string;
}): Promise<{
  subject: string;
  html: string;
  text: string;
  templateKey: PrebuiltEmailTemplateKey;
}> {
  const { renderToStaticMarkup } = await import("react-dom/server");

  const model = normalizeModel(params.templateModel);
  const template = findPrebuiltEmailTemplate(params.templateKey);
  if (!template) {
    throw new Error(`Unknown email template key: ${params.templateKey}`);
  }

  const baseSubject =
    String(params.subjectOverride || "").trim() || template.defaultSubject;
  const subject = applyTemplateVariables(baseSubject, model) || "Update";

  const component = renderTemplateComponent(template.key, model);
  const html = `<!doctype html>${renderToStaticMarkup(component)}`;
  const text = toPlainText(html);

  return {
    subject,
    html,
    text,
    templateKey: template.key,
  };
}
