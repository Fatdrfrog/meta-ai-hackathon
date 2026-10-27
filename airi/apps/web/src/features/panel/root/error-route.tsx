"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { captureClientException } from "@/lib/posthog/client";
import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

type PanelErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function PanelError({ error, reset }: PanelErrorProps) {
  const t = useTranslations("PanelError");

  useEffect(() => {
    console.error("[panel] route error boundary", error);
    captureClientException(error, { error_boundary: "panel" });
  }, [error]);

  return (
    <div className="flex h-full min-h-dvh w-full items-start justify-center overflow-y-auto bg-background px-3 py-6 sm:items-center sm:p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t("title")}</AlertTitle>
            <AlertDescription>{t("hint")}</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <Button type="button" className="w-full" onClick={reset}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t("retry")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
