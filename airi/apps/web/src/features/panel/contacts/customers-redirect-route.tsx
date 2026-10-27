import { redirect } from "next/navigation";

export default async function PageCustomers({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  redirect(`/panel/w/${encodeURIComponent(workspaceId)}/leads`);
}
