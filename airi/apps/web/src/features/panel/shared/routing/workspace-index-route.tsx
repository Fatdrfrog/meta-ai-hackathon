import { panelWorkspaceAiriHref } from "./hrefs";
import { redirect } from "next/navigation";

export default async function PanelIndex({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  // Middleware handles workspace validation
  // If user reaches this page, they have access to the workspace
  // Redirect to the Airi chat page for this workspace.
  const { workspaceId } = await params;
  redirect(panelWorkspaceAiriHref(workspaceId));
}
