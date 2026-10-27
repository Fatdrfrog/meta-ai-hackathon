import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Params = Promise<{ [key: string]: string | string[] | undefined }>;

export default async function DataDeletionPage({
  searchParams,
}: {
  searchParams: Params;
}) {
  const params = await searchParams;
  const confirmationId = params.id as string | undefined;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <CardTitle>Data Deletion Request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {confirmationId ? (
            <>
              <p className="text-sm text-muted-foreground">
                Your data deletion request has been received.
              </p>
              <div className="p-4 bg-muted rounded-lg">
                <p className="text-xs font-mono">{confirmationId}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                We will process your request within 30 days as required by data
                protection regulations. All data associated with your account
                will be permanently deleted.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                If you would like to request deletion of your data, please
                contact us at:
              </p>
              <div className="p-4 bg-muted rounded-lg">
                <a
                  href="mailto:support@airi.chat"
                  className="text-sm font-medium text-primary hover:underline"
                >
                  support@airi.chat
                </a>
              </div>
              <p className="text-xs text-muted-foreground">
                We take your privacy seriously and will respond to your request
                within 30 days.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
