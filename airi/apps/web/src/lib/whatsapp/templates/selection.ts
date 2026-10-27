export type WhatsAppTemplateNameLanguage = {
  name: string;
  language?: string;
};

export function getWhatsAppTemplateOptionValue(
  template: WhatsAppTemplateNameLanguage
): string {
  return `${template.name}::${template.language}`;
}
