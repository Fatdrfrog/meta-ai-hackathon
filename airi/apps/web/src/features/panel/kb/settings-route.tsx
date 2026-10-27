import { IndexedUrlsManager } from "@/components/kb/indexed-urls-manager";
import { BookOpen } from "lucide-react";
import { getTranslations } from "next-intl/server";

export default async function KBSettingsPage() {
  const t = await getTranslations("KnowledgeBase.settings");

  return (
    <div className="max-w-4xl space-y-6 overflow-x-hidden p-3 sm:p-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <BookOpen className="h-8 w-8" />
          {t("title")}
        </h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

      <IndexedUrlsManager />
    </div>
  );
}
