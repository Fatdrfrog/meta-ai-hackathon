import { getAppVersion } from "@/lib/app-version";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const appVersion = getAppVersion();

  return NextResponse.json(appVersion, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
    },
  });
}
