import { GoogleLogo } from "./assets/google_logo";
import AiriBlackIcon from "./assets/airi_black.svg";
import AiriWhiteIcon from "./assets/airi_white.svg";
import InstagramIcon from "./assets/instagram.svg";
import TelegramIcon from "./assets/telegram.svg";
import WhatsAppIcon from "./assets/whatsapp.svg";
import type { ComponentType } from "react";

export type IntegrationCategory = "channel" | "team" | "creative" | "widget";

export type IntegrationImageIcon = {
  src: string;
  height: number;
  width: number;
};
export type IntegrationIconType =
  | { src: string; height: number; width: number } // SVG import
  | typeof GoogleLogo
  | ComponentType<{ className?: string }>;
export interface IntegrationMetadata {
  id: string;
  name: string;
  icon: {
    light: IntegrationIconType;
    dark: IntegrationIconType;
  };
  category: IntegrationCategory;
  description: string;
  disabled?: boolean;
  // Component will be lazy loaded
}

const CanvaIcon = {
  src: "/canva-icon.svg",
  height: 24,
  width: 24,
};

const HiggsfieldIcon = {
  src: "/higgsfield-logo.png",
  height: 24,
  width: 24,
};

const ElevenLabsIcon = {
  src: "/elevenlabs-symbol.svg",
  height: 24,
  width: 24,
};

const PostmarkIcon = {
  src: "/postmark.png",
  height: 24,
  width: 24,
};

const MetaLightIcon = {
  src: "/meta_light.svg",
  height: 24,
  width: 24,
};

const MetaDarkIcon = {
  src: "/meta_dark.svg",
  height: 24,
  width: 24,
};

export const INTEGRATIONS: IntegrationMetadata[] = [
  // Channels. WhatsApp leads: it is the channel campaigns and most new
  // workspaces start with.
  {
    id: "whatsapp",
    name: "whatsapp.name",
    icon: { light: WhatsAppIcon, dark: WhatsAppIcon },
    category: "channel",
    description: "whatsapp.description",
  },
  {
    id: "telegram",
    name: "telegram.name",
    icon: { light: TelegramIcon, dark: TelegramIcon },
    category: "channel",
    description: "telegram.description",
  },
  {
    id: "instagram",
    name: "instagram.name",
    icon: { light: InstagramIcon, dark: InstagramIcon },
    category: "channel",
    description: "instagram.description",
  },
  // Team Tools
  {
    id: "email",
    name: "email.name",
    icon: { light: PostmarkIcon, dark: PostmarkIcon },
    category: "team",
    description: "email.description",
  },
  {
    id: "google_calendar",
    name: "google_calendar.name",
    icon: { light: GoogleLogo, dark: GoogleLogo },
    category: "team",
    description: "google_calendar.description",
  },
  {
    id: "google_ai",
    name: "google_ai.name",
    icon: { light: GoogleLogo, dark: GoogleLogo },
    category: "creative",
    description: "google_ai.description",
  },
  {
    id: "canva",
    name: "canva.name",
    icon: { light: CanvaIcon, dark: CanvaIcon },
    category: "creative",
    description: "canva.description",
  },
  {
    id: "meta_ads",
    name: "meta_ads.name",
    icon: { light: MetaLightIcon, dark: MetaDarkIcon },
    category: "creative",
    description: "meta_ads.description",
  },
  {
    id: "higgsfield",
    name: "higgsfield.name",
    icon: { light: HiggsfieldIcon, dark: HiggsfieldIcon },
    category: "creative",
    description: "higgsfield.description",
  },
  {
    id: "elevenlabs",
    name: "elevenlabs.name",
    icon: { light: ElevenLabsIcon, dark: ElevenLabsIcon },
    category: "creative",
    description: "elevenlabs.description",
  },
  // Widget
  {
    id: "web_widget",
    name: "web_widget.name",
    icon: { light: AiriBlackIcon, dark: AiriWhiteIcon },
    category: "widget",
    description: "web_widget.description",
  },
];

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  channel: "categories.channel",
  team: "categories.team",
  creative: "categories.creative",
  widget: "categories.widget",
};

export function getIntegrationById(
  id: string
): IntegrationMetadata | undefined {
  return INTEGRATIONS.find(integration => integration.id === id);
}
