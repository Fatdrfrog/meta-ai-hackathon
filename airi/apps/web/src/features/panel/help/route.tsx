import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowRight, BookOpen, Settings } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

export default async function HelpPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, t] = await Promise.all([
    params,
    getTranslations("HelpPage"),
  ]);

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="space-y-0.5">
        <h2 className="text-2xl font-bold tracking-tight">{t("title")}</h2>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              {t("gettingStartedTitle")}
            </CardTitle>
            <CardDescription>{t("quickLinks")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              asChild
              variant="outline"
              className="w-full justify-between"
            >
              <Link href={`/panel/w/${workspaceId}/settings/integrations`}>
                <span>{t("connectNewSource")}</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="w-full justify-between"
            >
              <Link href={`/panel/w/${workspaceId}/settings/team`}>
                <span>{t("inviteTeamMembers")}</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="w-full justify-between"
            >
              <Link href={`/panel/w/${workspaceId}/settings/ai-context`}>
                <span>{t("configureAiContext")}</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Documentation & Support */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              {t("documentation")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("documentationDescription")}
            </p>
            <ul className="text-sm space-y-2">
              <li>
                <Link href="#" className="text-primary hover:underline">
                  Understanding Conversations
                </Link>
              </li>
              <li>
                <Link href="#" className="text-primary hover:underline">
                  AI Classification Guide
                </Link>
              </li>
              <li>
                <Link href="#" className="text-primary hover:underline">
                  Airi Auto-Reply Settings
                </Link>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("contactSupportTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("contactSupportBody")}
            </p>
            <div className="flex gap-3">
              <Button asChild variant="default" size="sm">
                <a href="mailto:support@airi.chat">{t("emailSupport")}</a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a
                  href="https://t.me/airi_chat1"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("telegramSupport")}
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
