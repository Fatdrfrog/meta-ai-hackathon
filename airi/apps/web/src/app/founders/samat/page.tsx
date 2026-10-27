import BusinessCard from "@/components/business-card";
import { DEFAULT_OG_IMAGE_PATH } from "@/lib/public-seo";
import { createMetadata } from "@/lib/seo";
import { Metadata } from "next";

export const metadata: Metadata = createMetadata({
  title: "Samat Kalshabekov - Co-founder | Airi.chat",
  description:
    "Connect with Samat Kalshabekov, Co-founder of Airi.chat, a WhatsApp-first platform for bulk campaigns and AI follow-ups.",
  path: "/founders/samat",
  image: DEFAULT_OG_IMAGE_PATH,
  type: "profile",
});

export default function SamatPage() {
  const founderData = {
    name: "Samat Kalshabekov",
    title: "Co-founder",
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
        url: "https://www.linkedin.com/in/kalshabekov",
        icon: "💼",
        color: "bg-blue-600",
        subtitle: "Samat | Co-founder",
      },
      {
        platform: "Telegram",
        url: "https://t.me/fatdrfrog",
        icon: "✈️",
        color: "bg-blue-500",
        subtitle: "Samat | Co-founder",
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
