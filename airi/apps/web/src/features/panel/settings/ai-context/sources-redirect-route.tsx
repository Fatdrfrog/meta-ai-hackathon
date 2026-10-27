import { redirect } from "next/navigation";

export default async function AiContextSourcesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/panel/w/${workspaceId}/settings/ai-context`);
}
