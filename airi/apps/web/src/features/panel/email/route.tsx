import { EmailAutomationSettings } from "@/components/email/email-automation-settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getWorkspaceEmailConnectionStatus } from "@/lib/email/workspace-email-connection";
import { verifyWorkspaceAccess } from "@/lib/sources/utils";
import { getReadOnlySupabaseContext } from "@/features/panel/shared/workspace";
import Link from "next/link";
import { redirect } from "next/navigation";

type Params = Promise<{ workspaceId: string }>;

export default async function WorkspaceEmailPage({
  params,
}: {
  params: Params;
}) {
  const [{ workspaceId }, { supabase, user }] = await Promise.all([
    params,
    getReadOnlySupabaseContext(),
  ]);

  if (!user) {
    redirect("/login");
  }

  const hasAccess = await verifyWorkspaceAccess(supabase, user.id, workspaceId);
  if (!hasAccess) {
    redirect("/panel");
  }

  const connection = await getWorkspaceEmailConnectionStatus(workspaceId);

  if (!connection.connected) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Email</h1>
          <p className="text-sm text-muted-foreground">
            Connect email before enabling workspace email automation.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Email source required</CardTitle>
            <CardDescription>
              This screen becomes editable after the workspace has an active
              Postmark email provider.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm">
              <Link
                href={`/panel/w/${workspaceId}/settings/integrations?integration=email`}
              >
                Connect email
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <EmailAutomationSettings workspaceId={workspaceId} />;
}
