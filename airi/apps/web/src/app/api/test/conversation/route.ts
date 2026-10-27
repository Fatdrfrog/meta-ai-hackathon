/**
 * Test API endpoint to create test conversations for E2E tests
 */

import connectDB from "@/lib/mongoose";
import { verifyTestApiAccess } from "@/lib/internal-api-auth";
import Chat from "@/models/chat";
import { Conversation } from "@/models/conversation";
import User from "@/models/user";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const denied = verifyTestApiAccess(req);
  if (denied) return denied;

  try {
    await connectDB();

    const {
      channel,
      workspace_id,
      business_connection_id,
      chat_id,
      user_id,
      airi_bot_enabled,
      airi_coach_enabled,
    } = await req.json();

    if (!channel || !workspace_id || !chat_id) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Create or find chat document
    const chat = await Chat.findOneAndUpdate(
      { _id: chat_id },
      {
        _id: chat_id,
        type: "telegram",
        workspaceId: workspace_id,
        businessConnectionId: business_connection_id,
        sourceId: "test-source-id",
      },
      { upsert: true, new: true }
    );

    // Create or find user document
    const user = await User.findOneAndUpdate(
      { _id: user_id },
      {
        _id: user_id,
        isBot: false,
        firstName: "Test User",
      },
      { upsert: true, new: true }
    );

    // Create conversation
    const conversation = new Conversation({
      chat: chat._id,
      user: user._id,
      channel,
      workspaceId: workspace_id,
      business_connection_id,
      airi_bot_enabled: airi_bot_enabled ?? true,
      airi_scenarios_enabled: airi_bot_enabled ?? true,
      airi_coach_enabled: airi_coach_enabled ?? true,
      status: "open",
      messages: [],
      lastMessageAt: new Date(),
    });

    await conversation.save();

    return NextResponse.json({
      success: true,
      conversationId: conversation._id.toString(),
      conversation,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const denied = verifyTestApiAccess(req);
  if (denied) return denied;

  try {
    await connectDB();

    const { conversationId } = await req.json();

    if (!conversationId) {
      return NextResponse.json(
        { error: "Missing conversationId" },
        { status: 400 }
      );
    }

    await Conversation.findByIdAndDelete(conversationId);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
