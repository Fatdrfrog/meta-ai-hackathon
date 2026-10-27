import { validateTelegramBotToken } from "@/lib/telegram/validate-token";
import { NextRequest, NextResponse } from "next/server";

/**
 * Validate a Telegram bot token.
 * This endpoint is called from the client to validate bot tokens in real-time.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { bot_token } = body;

    if (!bot_token || typeof bot_token !== "string") {
      return NextResponse.json(
        { valid: false, error: "Bot token is required" },
        { status: 400 }
      );
    }

    const validation = await validateTelegramBotToken(bot_token);

    if (!validation.valid) {
      return NextResponse.json(
        {
          valid: false,
          error: validation.error || "Invalid bot token",
        },
        { status: 200 } // Return 200 even for invalid tokens, just mark as invalid
      );
    }

    return NextResponse.json({
      valid: true,
      botInfo: validation.botInfo,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    console.error("[Telegram Token Validation] Error:", error);
    return NextResponse.json(
      {
        valid: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
