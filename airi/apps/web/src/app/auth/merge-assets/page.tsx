import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getAccountMergePreviewForUser,
  getSafeAccountMergeNextPath,
} from "@/lib/auth/account-merge";
import {
  mergeAssetsAction,
  skipMergeAssetsAction,
} from "@/app/auth/merge-assets/actions";
import { createReadOnlyClient } from "@/lib/supabase/server";
import {
  isWorkspaceRole,
  type WorkspaceRole,
} from "@/lib/supabase/company-users";
import { AlertCircle, ArrowRight, Merge, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";

type MergeAssetsSearchParams = {
  next?: string;
  error?: string;
};

function getRoleLabel(
  role: string,
  labels: Record<WorkspaceRole, string>
): string {
  return isWorkspaceRole(role) ? labels[role] : role;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("MergeAssetsPage");

  return {
    title: t("metadataTitle"),
    description: t("metadataDescription"),
  };
}

export default async function MergeAssetsPage({
  searchParams,
}: {
  searchParams: Promise<MergeAssetsSearchParams>;
}): Promise<ReactElement> {
  const t = await getTranslations("MergeAssetsPage");
  const params = await searchParams;
  const nextPath = getSafeAccountMergeNextPath(params.next);
  const supabase = await createReadOnlyClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const preview = await getAccountMergePreviewForUser(user, {
    respectSkip: true,
    supabase,
  });
  if (!preview) {
    redirect(nextPath);
  }

  const legacyAccountCount = new Set(
    preview.candidates.map(candidate => candidate.legacyUserId)
  ).size;
  const workspaceCount = new Set(
    preview.candidates.map(candidate => candidate.workspaceId)
  ).size;
  const roleLabels: Record<WorkspaceRole, string> = {
    admin: t("roles.admin"),
    manager: t("roles.manager"),
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-8 sm:px-6">
      <div className="mb-8 flex w-full max-w-lg flex-row items-center justify-center gap-3">
        <Image
          src="/logo_short_white.svg"
          alt={t("brand")}
          width={80}
          height={80}
          className="hidden size-20 object-contain dark:block"
          priority
        />
        <Image
          src="/logo_short_black.svg"
          alt={t("brand")}
          width={80}
          height={80}
          className="block size-20 object-contain dark:hidden"
          priority
        />
        <span className="text-2xl font-bold leading-none">{t("brand")}</span>
      </div>

      <Card className="w-full max-w-lg bg-card text-card-foreground">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Merge className="size-6" />
          </div>
          <div>
            <CardTitle className="text-2xl">{t("title")}</CardTitle>
            <CardDescription className="mt-2">
              {t("description", { email: preview.email })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {params.error ? (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertDescription>{params.error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <UsersRound className="size-4 text-muted-foreground" />
              {t("workspaceSummary", {
                workspaceCount,
                legacyAccountCount,
              })}
            </div>
            <div className="space-y-2">
              {preview.candidates.slice(0, 4).map(candidate => (
                <div
                  key={`${candidate.legacyUserId}:${candidate.membershipId}`}
                  className="flex items-center justify-between gap-3 rounded-md bg-background px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {candidate.workspaceName}
                    </div>
                    {candidate.companyName ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {candidate.companyName}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {getRoleLabel(candidate.role, roleLabels)}
                  </span>
                </div>
              ))}
              {preview.candidates.length > 4 ? (
                <p className="text-xs text-muted-foreground">
                  {t("moreCandidates", {
                    count: preview.candidates.length - 4,
                  })}
                </p>
              ) : null}
            </div>
          </div>

          <form action={mergeAssetsAction}>
            <input type="hidden" name="next" value={nextPath} />
            <Button type="submit" className="h-10 w-full">
              {t("mergeAndContinue")}
              <ArrowRight className="ml-2 size-4" />
            </Button>
          </form>

          <form action={skipMergeAssetsAction}>
            <input type="hidden" name="next" value={nextPath} />
            <Button type="submit" variant="ghost" className="h-10 w-full">
              {t("continueWithoutMerging")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
