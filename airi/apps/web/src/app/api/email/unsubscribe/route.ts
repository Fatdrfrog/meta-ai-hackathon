import {
  recordEmailUnsubscribe,
  verifyEmailUnsubscribeToken,
} from "@/lib/email/email-unsubscribes";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function htmlResponse(status: number, title: string, message: string) {
  return new NextResponse(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:32px;font-family:Arial,Helvetica,sans-serif;color:#111827;background:#f4f6f8;">
    <main style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;">
      <h1 style="margin:0 0 12px;font-size:24px;line-height:32px;">${title}</h1>
      <p style="margin:0;font-size:16px;line-height:24px;">${message}</p>
    </main>
  </body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

async function markCampaignMessageUnsubscribed(params: {
  campaignId?: string | null;
  email: string;
  unsubscribedAt: string;
}) {
  if (!params.campaignId) return;

  await supabaseAdmin
    .from("campaign_messages")
    .update({
      status: "unsubscribed",
      unsubscribed_at: params.unsubscribedAt,
      updated_at: params.unsubscribedAt,
    })
    .eq("campaign_id", params.campaignId)
    .eq("channel", "email")
    .eq("recipient", params.email);
}

// GET only verifies the signed token and renders a confirmation form; the unsubscribe write is POST-only.
// react-doctor-disable-next-line react-doctor/nextjs-no-side-effect-in-get-handler
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const verification = verifyEmailUnsubscribeToken(token);

  if (!verification.valid || !verification.payload) {
    return htmlResponse(
      400,
      "Invalid unsubscribe link",
      "This unsubscribe link is invalid or has been changed."
    );
  }

  return new NextResponse(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Confirm Unsubscribe</title>
    <style>
      body {
        margin: 0;
        padding: 32px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #f8fafc;
        background-color: #020617;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        box-sizing: border-box;
      }
      main {
        max-width: 480px;
        width: 100%;
        background-color: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 16px;
        padding: 40px;
        text-align: center;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      }
      h1 {
        margin: 0 0 16px;
        font-size: 24px;
        font-weight: 700;
        color: #f1f5f9;
      }
      p {
        margin: 0 0 32px;
        font-size: 15px;
        line-height: 24px;
        color: #94a3b8;
      }
      button {
        display: inline-block;
        width: 100%;
        padding: 14px 24px;
        font-size: 15px;
        font-weight: 600;
        color: #020617;
        background: linear-gradient(135deg, #fbbf24, #f59e0b);
        border: none;
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      button:hover {
        background: linear-gradient(135deg, #fcd34d, #fbbf24);
        transform: translateY(-1px);
      }
      button:active {
        transform: translateY(0);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Confirm Unsubscribe</h1>
      <p>Are you sure you want to unsubscribe from future marketing emails? You can always manage your notifications under settings.</p>
      <form action="/api/email/unsubscribe?token=${encodeURIComponent(token)}" method="POST">
        <button type="submit">Confirm Unsubscribe</button>
      </form>
    </main>
  </body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const verification = verifyEmailUnsubscribeToken(token);

  if (!verification.valid || !verification.payload) {
    return htmlResponse(
      400,
      "Invalid unsubscribe link",
      "This unsubscribe link is invalid or has been changed."
    );
  }

  const unsubscribedAt = new Date().toISOString();
  const result = await recordEmailUnsubscribe({
    supabase: supabaseAdmin,
    workspaceId: verification.payload.workspaceId,
    email: verification.payload.email,
    campaignId: verification.payload.campaignId || null,
    source: "unsubscribe_link",
    unsubscribedAt,
  });

  if (!result.ok) {
    return htmlResponse(
      500,
      "Unsubscribe failed",
      "We could not update your email preferences. Please try again later."
    );
  }

  await markCampaignMessageUnsubscribed({
    campaignId: verification.payload.campaignId || null,
    email: verification.payload.email,
    unsubscribedAt,
  });

  return htmlResponse(
    200,
    "Unsubscribed",
    "You have been unsubscribed from future marketing emails from this workspace."
  );
}
