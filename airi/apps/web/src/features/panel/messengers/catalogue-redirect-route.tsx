import { redirect } from "next/navigation";

export default async function WhatsAppCatalogueRedirectPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/panel/w/${workspaceId}/messengers/catalog`);
}
