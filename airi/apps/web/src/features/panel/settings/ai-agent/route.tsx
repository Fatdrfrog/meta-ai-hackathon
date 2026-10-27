import AgentSettingsView from "@/components/settings/agent-settings-view";
import { AiriBotSettingsCard } from "@/components/settings/airi-bot-settings-card";
import { getTranslations } from "next-intl/server";

export default async function AiAgentSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const [{ workspaceId }, t] = await Promise.all([
    params,
    getTranslations("Settings"),
  ]);

  return (
    <div className="@container/ai-agent space-y-5 animate-in fade-in-50 duration-500">
      <div className="space-y-1">
        <h3 className="text-xl font-semibold tracking-tight">
          {t("aiAgentTitle")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("aiAgentDescription")}
        </p>
      </div>
      <div className="grid items-start gap-5 @min-[56rem]/ai-agent:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <AgentSettingsView workspaceId={workspaceId} />
        <AiriBotSettingsCard workspaceId={workspaceId} />
      </div>
    </div>
  );
}
