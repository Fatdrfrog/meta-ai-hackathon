import { AiriLanguageSelector } from "@/components/settings/airi-language-selector";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import {
  getCompanyIdForWorkspace,
  isCompanyAdminRole,
} from "@/lib/supabase/company-users";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import {
  isConversationPreferredLanguage,
  type ConversationPreferredLanguage as AiriLanguage,
} from "@icecore/shared/types/conversation";

async function getCompanyLanguage(
  workspaceId: string
): Promise<{ language: AiriLanguage; canManage: boolean } | null> {
  const { supabase, user } = await getReadOnlySupabaseContext();

  if (!user) {
    redirect("/login");
  }

  try {
    const { data: membership, error: membershipError } = await supabase
      .from("company_users")
      .select("workspace_id, role")
      .eq("user_id", user.id)
      .eq("workspace_id", workspaceId)
      .single();

    if (membershipError || !membership?.workspace_id) {
      return null;
    }

    const companyId = await getCompanyIdForWorkspace(supabase, workspaceId);
    if (!companyId) {
      return null;
    }

    const { data: company, error: companyError } = await supabase
      .from("companies")
      .select("airi_language")
      .eq("id", companyId)
      .single();

    if (companyError || !company) return null;

    const language = company?.airi_language;
    const resolved = isConversationPreferredLanguage(language)
      ? language
      : language == null || language === ""
        ? "en"
        : null;
    return resolved
      ? { language: resolved, canManage: isCompanyAdminRole(membership.role) }
      : null;
  } catch {
    return null;
  }
}

export default async function AiriLanguageSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [currentLanguage, t] = await Promise.all([
    getCompanyLanguage(workspaceId),
    getTranslations("AiriLanguageSettings"),
  ]);

  return (
    <div className="space-y-6 animate-in fade-in-50 duration-500">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          {t("title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {currentLanguage ? (
        <AiriLanguageSelector
          key={workspaceId}
          initialLanguage={currentLanguage.language}
          readOnly={!currentLanguage.canManage}
        />
      ) : (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm"
        >
          {t("loadFailed")}
        </p>
      )}
      <p className="max-w-2xl text-xs text-muted-foreground">
        {t("coachingPriority")}
      </p>
    </div>
  );
}
