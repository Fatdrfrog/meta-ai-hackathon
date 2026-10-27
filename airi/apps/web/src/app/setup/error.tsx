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
import { AlertCircle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

type SetupErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function SetupError({ error, reset }: SetupErrorProps) {
  const t = useTranslations("AddCompanyForm");

  useEffect(() => {
    console.error("[setup] page error boundary", error);
  }, [error]);

  return (
    <div className="flex h-dvh items-start justify-center overflow-y-auto bg-linear-to-br from-[#fec8e7]/30 via-[#e7c9ff]/20 to-[#cfffe1]/30 px-3 py-3 sm:p-6">
      <Card className="w-full max-w-lg overflow-hidden rounded-[2.5rem] border-4 border-foreground bg-card text-card-foreground shadow-[8px_8px_0px_#000000] dark:shadow-[8px_8px_0px_rgba(255,255,255,0.15)]">
        <CardHeader className="border-b-4 border-foreground bg-[#fdf0a6] px-5 py-4 text-black dark:bg-yellow-950/40 dark:text-foreground sm:px-6 sm:py-5">
          <CardTitle className="text-xl font-black">
            {t("setupErrorTitle")}
          </CardTitle>
          <CardDescription className="text-sm font-bold text-black/70 dark:text-foreground/80">
            {t("setupErrorDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 py-5 sm:px-6">
          <Alert
            variant="destructive"
            className="rounded-2xl border-[3px] border-foreground shadow-[3px_3px_0px_#000000]"
          >
            <AlertCircle />
            <AlertTitle className="font-bold">{t("setupErrorTitle")}</AlertTitle>
            <AlertDescription className="font-semibold">
              {t("setupErrorHint")}
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter className="border-t-4 border-foreground bg-muted/20 px-5 py-4 sm:px-6">
          <Button type="button" className="w-full" onClick={reset}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t("setupErrorRetry")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
