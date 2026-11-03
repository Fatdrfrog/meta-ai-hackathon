import {
  panelConnectWhatsAppOnboardingHref,
  panelWorkspaceHref,
} from "@/features/panel/shared/routing/hrefs";

// Where a kit's next steps lead, elsewhere in airi.

/** WhatsApp Flows, where the order form is listed (and a draft is published). */
export function whatsAppFlowsHref(workspaceId: string): string {
  return panelWorkspaceHref(workspaceId, "messengers/whatsapp-flows");
}

/** Templates, opening the editor on the template with this name. */
export function templateHref(workspaceId: string, name: string | null): string {
  return panelWorkspaceHref(
    workspaceId,
    name
      ? `messengers/whatsapp-templates?template=${encodeURIComponent(name)}`
      : "messengers/whatsapp-templates"
  );
}

/** Assets, where the company's media storage is freed. */
export function assetsHref(workspaceId: string): string {
  return panelWorkspaceHref(workspaceId, "assets");
}

/** Settings › Integrations with WhatsApp chosen, to connect a number. */
export function connectWhatsAppHref(workspaceId: string): string {
  return panelConnectWhatsAppOnboardingHref(workspaceId);
}
