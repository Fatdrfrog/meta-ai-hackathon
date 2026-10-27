import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{
    workspaceId: string;
  }>;
}

export default async function WidgetOnboardingRedirect({ params }: PageProps) {
  const { workspaceId } = await params;

  redirect(`/panel/w/${workspaceId}/widget-branding`);
}
