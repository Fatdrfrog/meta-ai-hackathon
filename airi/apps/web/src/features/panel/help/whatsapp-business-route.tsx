import { redirect } from "next/navigation";

export default async function WhatsAppBusinessSetupGuide({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  redirect(
    `/panel/w/${workspaceId}/settings/integrations?type=whatsapp&integration=whatsapp`
  );
}
