import { redirect } from "next/navigation";

export default async function TelegramBusinessSetupGuide({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  redirect(
    `/panel/w/${workspaceId}/settings/integrations?type=telegram&integration=telegram`
  );
}
