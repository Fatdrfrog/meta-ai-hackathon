import { getReadOnlySupabaseUser } from "@/features/panel/shared/workspace";
import { ProfileForm } from "./components/profile-form";
import { getTranslations } from "next-intl/server";

export default async function ProfileSettingsPage() {
  const [user, t] = await Promise.all([
    getReadOnlySupabaseUser(),
    getTranslations("Settings"),
  ]);

  return (
    <div className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold tracking-tight">
          {t("profileTitle")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("profileDescription")}
        </p>
      </div>
      <ProfileForm user={user} />
    </div>
  );
}
