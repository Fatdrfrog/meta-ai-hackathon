import BusinessCard from "@/components/business-card";
import { DEFAULT_OG_IMAGE_PATH } from "@/lib/public-seo";
import { createMetadata } from "@/lib/seo";
import { Metadata } from "next";

export const metadata: Metadata = createMetadata({
  title: "Aisulu Kalshabekova - Co-founder & CEO | Airi.chat",
  description:
    "Connect with Aisulu Kalshabekova, Co-founder and CEO of Airi.chat, a WhatsApp-first platform for bulk campaigns and AI follow-ups.",
  path: "/founders/aisulu",
  image: DEFAULT_OG_IMAGE_PATH,
  type: "profile",
});

export default function AisuluPage() {
  const founderData = {
    name: "Aisulu Kalshabekova",
    title: "Co-founder & CEO",
    company: "Airi.chat",
    description:
      "Airi.chat helps teams launch official WhatsApp bulk campaigns, read every reply, and turn customer signals into timely AI-assisted follow-ups.",
    links: [
      {
        platform: "Website",
        url: "https://www.airi.chat",
        icon: "🌐",
        color: "bg-emerald-500",
      },
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/in/aisulu-kalshabekova/",
        icon: "💼",
        color: "bg-blue-600",
        subtitle: "Aisulu | Co-founder, CEO",
      },
      {
        platform: "Telegram",
        url: "https://t.me/aiskalshabekova",
        icon: "✈️",
        color: "bg-blue-500",
        subtitle: "Aisulu | Co-founder, CEO",
      },
    ],
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <BusinessCard
        data={founderData}
        enableTilt={true}
        enableMobileTilt={true}
        mobileTiltSensitivity={8}
      />
    </div>
  );
}
