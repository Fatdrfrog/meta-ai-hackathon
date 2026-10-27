import { IntegrationsContent } from "./components/integrations-content";

type Params = Promise<{ workspaceId: string }>;

export default async function IntegrationsSettingsPage({
  params,
}: {
  params: Params;
}) {
  const { workspaceId } = await params;

  return <IntegrationsContent workspaceId={workspaceId} />;
}
