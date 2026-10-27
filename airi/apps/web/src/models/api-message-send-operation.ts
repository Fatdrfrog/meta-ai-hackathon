import mongoose, { type Model } from "mongoose";

export type ApiMessageSendResponse = {
  success: true;
  messageId: string;
  sentAt: string;
};

export type ApiMessageSendOperationRecord = {
  _id: string;
  workspaceId: string;
  apiKeyId: string;
  conversationId: string;
  sourceId: string;
  payloadDigest: string;
  state: "pending" | "completed" | "unknown";
  messageId: string;
  providerMessageId?: string;
  sentAt?: Date;
  response?: ApiMessageSendResponse;
  createdAt: Date;
  updatedAt: Date;
};

const ApiMessageSendOperationSchema =
  new mongoose.Schema<ApiMessageSendOperationRecord>(
    {
      // Mongo's built-in unique _id index fences concurrent sends without index setup.
      _id: { type: String, required: true, immutable: true },
      workspaceId: { type: String, required: true, immutable: true },
      apiKeyId: { type: String, required: true, immutable: true },
      conversationId: { type: String, required: true, immutable: true },
      sourceId: { type: String, required: true, immutable: true },
      payloadDigest: { type: String, required: true, immutable: true },
      state: {
        type: String,
        enum: ["pending", "completed", "unknown"],
        required: true,
      },
      messageId: { type: String, required: true, immutable: true },
      providerMessageId: { type: String },
      sentAt: { type: Date },
      response: {
        type: new mongoose.Schema<ApiMessageSendResponse>(
          {
            success: {
              type: Boolean,
              required: true,
              validate: {
                validator: (value: boolean) => value === true,
                message: "Only successful send responses may be cached",
              },
            },
            messageId: { type: String, required: true },
            sentAt: { type: String, required: true },
          },
          { _id: false }
        ),
      },
    },
    { timestamps: true, collection: "api_message_send_operations" }
  );

// Deliberately no TTL or lease takeover: expiry must never make an ambiguous
// provider dispatch eligible for another send with the same key.
export default (mongoose.models.ApiMessageSendOperation as
  | Model<ApiMessageSendOperationRecord>
  | undefined) ||
  mongoose.model<ApiMessageSendOperationRecord>(
    "ApiMessageSendOperation",
    ApiMessageSendOperationSchema
  );
