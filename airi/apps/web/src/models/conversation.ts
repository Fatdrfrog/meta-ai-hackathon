import { CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC, CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC } from "@icecore/airi-runtime/whatsapp-conversation-ownership";
export { CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC, CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC };
import {
  CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS,
  CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
} from "@icecore/shared/lib/conversation-classification-freshness";
import {
  CONVERSATION_CUSTOMER_LANGUAGE_SOURCES,
  CONVERSATION_PREFERRED_LANGUAGES,
  CONVERSATION_STATUSES,
  normalizeConversationPreferredLanguage,
} from "@icecore/shared/types/conversation";
import type {
  AgentPerformanceScorecard,
  InteractionMetrics,
} from "@icecore/shared/types/models";
import { CONVERSATION_CHANNELS } from "@icecore/shared/types/sources";
import {
  GENERATIVE_AI_ACTION_MODES,
  GENERATIVE_AI_DELIVERY_MEDIA_TYPES,
  GENERATIVE_AI_EXECUTION_PHASES,
  GENERATIVE_AI_INPUT_KINDS,
  GENERATIVE_AI_RESULT_DELIVERY_KINDS,
  type GenerativeAIDeliveryAttachment,
  type GenerativeAIDeliveryClaim,
  type GenerativeAIExecution,
  type GenerativeAISourceMedia,
  type GenerativeAITransition,
} from "@icecore/scenario-contracts";

import mongoose, { type ClientSession } from "mongoose";
import { stripPrivateEngagementState } from "@/lib/engagement/message-engagement-refresh";
import { randomUUID } from "node:crypto";
import { buildServiceLifecycleTransition, ConversationLifecycleWriteConflictError, decodeServiceLifecycleEnvelope, SERVICE_RESOLUTION_KINDS, type ServiceLifecycleSnapshot, type ServiceResolutionKind } from "@/lib/analytics/service-lifecycle";

export const CONVERSATION_CLASSIFICATION_STATUSES = [
  "pending",
  "processing",
  "ready",
  "review_required",
  "failed",
  "blocked",
  "not_applicable",
] as const;

const ClassificationLeaseSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    ownerToken: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { _id: false }
);

const ClassificationStateSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    contractVersion: {
      type: Number,
      enum: [CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION],
      required: true,
    },
    status: {
      type: String,
      enum: CONVERSATION_CLASSIFICATION_STATUSES,
      required: true,
    },
    requestedRevision: { type: Number, required: true, min: 0 },
    processingRevision: { type: Number, default: null, min: 1 },
    appliedRevision: { type: Number, default: null, min: 1 },
    generation: { type: Number, required: true, min: 0 },
    attemptRevision: { type: Number, required: true, min: 0 },
    attemptCount: { type: Number, required: true, min: 0 },
    fence: { type: Number, required: true, min: 0 },
    requestedAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    lastEnqueuedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lease: { type: ClassificationLeaseSchema, default: null },
    error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      retryable: { type: Boolean, default: null },
      at: { type: Date, default: null },
    },
    review: {
      code: { type: String, default: null },
      reason: { type: String, default: null },
      at: { type: Date, default: null },
    },
    blocked: {
      code: { type: String, default: null },
      reason: { type: String, default: null },
      recheckAt: { type: Date, default: null },
    },
  },
  { _id: false }
);

const ConversationSchema = new mongoose.Schema<Record<string, unknown>>(
  {
    // Chat linkage - can be Number (Telegram) or String (other channels)
    chat: { type: mongoose.Schema.Types.Mixed, ref: "Chat", required: false },
    user: { type: mongoose.Schema.Types.Mixed, ref: "User", required: false },

    // Business connection ID for Telegram Business conversations
    // This distinguishes business conversations from private bot chats
    business_connection_id: { type: String, required: false },

    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: "Message" }],
    message_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: CONVERSATION_STATUSES,
      default: "open",
    },
    // Whether the latest customer activity has been viewed by a manager.
    // Backward compatibility: any non-true value should be treated as unread.
    is_read_by_manager: {
      type: Boolean,
      default: false,
    },

    channel: {
      type: String,
      enum: CONVERSATION_CHANNELS,
      default: "telegram",
    },

    workspaceId: { type: String, required: true },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    // Explicitly link conversation to a specific source (e.g. specific WhatsApp number)
    // This prevents issues when a workspace has multiple sources of the same channel
    sourceId: { type: String, required: false },
    // Partial unique indexes enroll canonical owners without rewriting legacy siblings.
    whatsappConversationIdentityKey: { type: String, select: false },
    whatsappConversationIdentityKeys: { type: [String], default: undefined, select: false },
    whatsappGroup: {
      groupId: { type: String, default: null },
      phoneNumberId: { type: String, default: null },
      sourceId: { type: String, default: null },
      subject: { type: String, default: null },
    },
    customerLinkedAt: { type: Date, default: null },
    customerLinkedBy: { type: String, default: null },
    customerLinkMethod: {
      type: String,
      enum: ["system", "backfill", "manual", "suggested", "rule"],
      default: null,
    },
    customerLinkConfidence: {
      type: Number,
      default: null,
    },

    lastMessageAt: { type: Date, default: null },

    // Denormalized message timestamps for fast analytics filtering.
    // Maintained by Message post-save hook and the
    // scripts/backfill-conversation-denorm.ts script.
    last_outbound_at: { type: Date, default: null },
    last_inbound_at: { type: Date, default: null },
    first_inbound_at: { type: Date, default: null },
    first_response_at: { type: Date, default: null },
    first_response_seconds: { type: Number, default: null },
    first_response_manager_id: { type: String, default: null },
    first_response_manager_name: { type: String, default: null },

    // Stable service evidence. The envelope and status change share one write.
    service_episode_started_at: { type: Date, default: null },
    service_closed_at: { type: Date, default: null },
    service_resolved_at: { type: Date, default: null },
    service_resolution_kind: { type: String, enum: [...SERVICE_RESOLUTION_KINDS, null], default: null },
    service_lifecycle_revision: { type: Number, default: 0, min: 0 },
    service_lifecycle_event: { type: String, default: null, set: (value: unknown) => value == null || typeof value === "string" ? value : JSON.stringify(value), get: decodeServiceLifecycleEnvelope },
    service_lifecycle_event_key: { type: String, default: null },

    subject: { type: String, default: null },
    rename: { type: String, default: null, trim: true, maxlength: 120 },
    // The name this workspace's campaign file gave the contact; the shared
    // WhatsApp contact records never hold one workspace's label.
    campaign_recipient_name: { type: String, default: null, trim: true, maxlength: 120 },
    quick_note: { type: String, default: null, trim: true, maxlength: 1000 },
    quick_note_updated_at: { type: Date, default: null },
    quick_note_updated_by: { type: String, default: null },

    participants: {
      from: { type: [String], default: [] },
      to: { type: [String], default: [] },
    },
    external_thread: {
      provider: {
        type: String,
        enum: ["postmark", "instagram"],
        default: undefined,
      },
      type: {
        type: String,
        enum: ["comment"],
        default: undefined,
      },
      threadId: { type: String, default: undefined },
      permalink: { type: String, default: undefined },
      comment: {
        id: { type: String, default: undefined },
        timestamp: { type: Date, default: undefined },
        parentId: { type: String, default: undefined },
        hidden: { type: Boolean, default: undefined },
        likeCount: { type: Number, default: undefined },
      },
      media: {
        id: { type: String, default: undefined },
        mediaType: { type: String, default: undefined },
        mediaProductType: { type: String, default: undefined },
        shortcode: { type: String, default: undefined },
        timestamp: { type: Date, default: undefined },
        caption: { type: String, default: undefined },
        mediaUrl: { type: String, default: undefined },
        thumbnailUrl: { type: String, default: undefined },
        username: { type: String, default: undefined },
      },
      referral: {
        source: { type: String, default: undefined },
        type: { type: String, default: undefined },
        ref: { type: String, default: undefined },
        adId: { type: String, default: undefined },
        campaignId: { type: String, default: undefined },
        campaignName: { type: String, default: undefined },
        adSetId: { type: String, default: undefined },
        adSetName: { type: String, default: undefined },
        productId: { type: String, default: undefined },
        productRetailerId: { type: String, default: undefined },
        title: { type: String, default: undefined },
        body: { type: String, default: undefined },
        mediaUrl: { type: String, default: undefined },
        sourceUrl: { type: String, default: undefined },
        adAccountId: { type: String, default: undefined },
        campaignLabels: {
          type: [
            new mongoose.Schema<Record<string, unknown>>(
              {
                id: { type: String, required: true },
                name: { type: String, default: undefined },
              },
              { _id: false }
            ),
          ],
          default: undefined,
        },
        campaignLabelStatus: {
          type: String,
          enum: ["present", "absent", "unavailable"],
          default: undefined,
        },
      },
      headers: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },

    history_summary: {
      type: String,
      default: null,
    },

    airi_context_memory: {
      version: { type: Number, default: 1 },
      summary: { type: String, default: null },
      currentGoal: { type: String, default: null },
      unresolvedNeeds: { type: [String], default: [] },
      resolvedNeeds: { type: [String], default: [] },
      preferredLanguage: { type: String, default: null },
      coveredThroughMessageId: { type: String, default: null },
      coveredMessageCount: { type: Number, default: 0 },
      lastGrounding: {
        sourceKind: {
          type: String,
          enum: ["snippet", "kb", "mixed", "none"],
          default: "none",
        },
        sourceIds: { type: [String], default: [] },
        intentAnchor: { type: String, default: null },
        answeredAsks: { type: [String], default: [] },
        updatedAt: { type: Date, default: null },
      },
      activeSelection: {
        kind: {
          type: String,
          enum: ["offer", "program", "payment", "product"],
          default: null,
        },
        label: { type: String, default: null },
        normalizedLabel: { type: String, default: null },
        sourceKind: {
          type: String,
          enum: ["snippet", "kb", "mixed"],
          default: null,
        },
        sourceIds: { type: [String], default: [] },
        quotedPriceText: { type: String, default: null },
        quotedPriceAmount: { type: Number, default: null },
        quotedPriceCurrency: { type: String, default: null },
        updatedAt: { type: Date, default: null },
      },
      updatedAt: { type: Date, default: null },
    },

    is_classified: {
      type: Boolean,
      default: false,
    },

    classification_revision: {
      type: Number,
      default: 0,
      min: 0,
    },
    classification_state: {
      type: ClassificationStateSchema,
      default: null,
    },

    classification: {
      category: {
        type: String,
      },
      priority: {
        type: String,
        enum: ["low", "medium", "high", "urgent"],
      },
      sentiment: {
        type: String,
        enum: ["positive", "neutral", "negative"],
      },
      summary: { type: String },
      action: { type: String },
      tags: { type: [String], default: [] },
      confidence: {
        category: { type: Number },
        priority: { type: Number },
        sentiment: { type: Number },
      },
    },

    // Unverified evidence from the current classification revision; merchants
    // confirm sales through the existing conversions API.
    payment_suggestions: {
      type: [
        new mongoose.Schema<Record<string, unknown>>(
          {
            messageId: { type: String, required: true },
            kind: {
              type: String,
              enum: ["receipt", "payment_claim"],
              required: true,
            },
            amount: { type: Number, default: null },
            currency: { type: String, default: null },
            occurredAt: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Secondary (shadow) classification for A/B testing / experimentation
    shadow_classification: {
      category: { type: String },
      priority: { type: String },
      sentiment: { type: String },
      summary: { type: String },
      action: { type: String },
      tags: { type: [String], default: [] },
      confidence: {
        category: { type: Number },
        priority: { type: Number },
        sentiment: { type: Number },
      },
    },

    // Classifier metadata and error tracking
    classification_meta: {
      provenance_kind: {
        type: String,
        enum: CONVERSATION_CLASSIFICATION_PROVENANCE_KINDS,
        default: null,
      },
      taxonomy_id: { type: String, default: null },
      classifier_version: { type: String, default: null },
      source_revision: { type: Number, default: null },
      taxonomy_digest: { type: String, default: null },
      classifier_contract_revision: { type: Number, default: null },
      analysis_revision_id: { type: String, default: null },
      completed_at: { type: Date, default: null },
    },
    classification_error: { type: String, default: null },

    extracted_entities: {
      type: [
        {
          type: { type: String, required: true },
          value: { type: String, required: true },
        },
      ],
      default: [],
    },

    key_moments: {
      type: [
        {
          type: { type: String, required: true },
          message_ref: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Message",
            required: true,
          },
        },
      ],
      default: [],
    },

    interaction_metrics: {
      type: new mongoose.Schema<InteractionMetrics>(
        {
          talk_ratio: { type: Number },
          agent_response_time_avg_sec: { type: Number },
          customer_question_count: { type: Number },
        },
        { _id: false }
      ),
      default: null,
    },
    // Legacy home of the engagement state, now in conversation_engagement_states;
    // adopted conversations keep a "moved" marker here so older deployments back off.
    engagement_accumulator: { type: mongoose.Schema.Types.Mixed, select: false },
    // State revision of the copied engagement_metrics; a stale copy never overwrites a newer one.
    engagement_revision: { type: Number, select: false },
    engagement_metrics: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          version: { type: Number, default: 1 },
          computedAt: { type: Date, default: null },
          messageCount: { type: Number, default: 0 },
          inboundCount: { type: Number, default: 0 },
          outboundCount: { type: Number, default: 0 },
          customerQuestionCount: { type: Number, default: 0 },
          firstMessageAt: { type: Date, default: null },
          lastMessageAt: { type: Date, default: null },
          activeDurationMinutes: { type: Number, default: null },
          hasTwoWayConversation: { type: Boolean, default: false },
          turnSwitchCount: { type: Number, default: 0 },
          customerRepliesAfterOutbound: { type: Number, default: 0 },
          firstCustomerReplyDelayMinutes: { type: Number, default: null },
          avgCustomerReplyDelayMinutes: { type: Number, default: null },
          inboundMediaCount: { type: Number, default: 0 },
          inboundVoiceCount: { type: Number, default: 0 },
          flowSubmitCount: { type: Number, default: 0 },
          reactionCount: { type: Number, default: 0 },
          templateOutboundCount: { type: Number, default: 0 },
          campaignReplyCount: { type: Number, default: 0 },
          deliveredCount: { type: Number, default: 0 },
          readCount: { type: Number, default: 0 },
          score: { type: Number, default: 0 },
          scoreParts: {
            depth: { type: Number, default: 0 },
            reciprocity: { type: Number, default: 0 },
            intent: { type: Number, default: 0 },
            richness: { type: Number, default: 0 },
            delivery: { type: Number, default: 0 },
          },
        },
        { _id: false }
      ),
      default: null,
    },

    agent_performance_scorecard: {
      type: new mongoose.Schema<AgentPerformanceScorecard>(
        {
          empathy_score: { type: Number },
          clarity_score: { type: Number },
          script_adherence_score: { type: Number },
          resolution_efficiency_score: { type: Number },
          overall_comment: { type: String },
        },
        { _id: false }
      ),
      default: null,
    },

    is_best_practice: {
      type: Boolean,
      default: false,
    },
    is_qa_analyzed: { type: Boolean, default: false },

    customer_satisfaction_score: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    customer_satisfaction_comment: {
      type: String,
      default: null,
    },

    // CSAT flow tracking
    awaiting_csat: {
      type: Boolean,
      default: false,
    },
    // True when CSAT window expired after 24h with no response
    csat_timeout_closed: {
      type: Boolean,
      default: false,
    },

    // Mission - Customer Health & Revenue Attribution
    estimated_customer_ltv: {
      type: Number,
      default: null,
    },
    health_score_snapshot: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
    health_score_factors: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    health_scored_at: {
      type: Date,
      default: null,
    },
    health_score_version: {
      type: Number,
      default: null,
    },
    revenue_attribution_id: {
      type: String, // UUID from Supabase
      default: null,
    },
    churn_risk_level: {
      type: String,
      enum: ["none", "low", "medium", "high"],
      default: "none",
    },
    recommended_action: {
      type: String,
      default: null,
    },

    handled_by_agent_id: {
      type: String,
      default: null,
    },

    // Airi per-conversation controls
    // Separate controls for bot auto-replies, scenarios, and coach suggestions.
    airi_bot_enabled: { type: Boolean, default: false }, // AI bot auto-replies - default OFF
    airi_scenarios_enabled: { type: Boolean, default: true }, // AI scenario automation - default ON
    airi_coach_enabled: { type: Boolean, default: true }, // AI coaching suggestions - default ON
    airi_assigned_by: { type: String, default: null },
    airi_handoff_active: { type: Boolean, default: false },
    airi_handoff_started_at: { type: Date, default: null },
    airi_handoff_restore_bot_enabled: { type: Boolean, default: null },
    airi_handoff_source: {
      type: String,
      enum: ["scenario_contains", "scenario_timeout", "manual"],
      default: null,
    },
    airi_handoff_reason: { type: String, default: null },
    airi_last_suppressed_at: { type: Date, default: null },
    airi_last_suppressed_reason: {
      type: String,
      enum: [
        "manager_recently_replied",
        "tagged_manager_message",
        "scenario_handoff",
      ],
      default: null,
    },
    airi_last_suppressed_manager_user_id: { type: String, default: null },
    airi_last_suppressed_message_id: { type: String, default: null },
    // Field names and enums follow the scenario-contracts execution shape that
    // the generative execution store parses; `satisfies` keeps them aligned.
    airi_pending_generative_execution: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          version: { type: Number, enum: [1], required: true },
          configVersion: { type: Number, enum: [1], required: true },
          executionId: { type: String, required: true },
          phase: {
            type: String,
            enum: GENERATIVE_AI_EXECUTION_PHASES,
            required: true,
          },
          scenarioId: { type: String, required: true },
          scenarioRevisionFingerprint: { type: String, required: true },
          actionNodeId: { type: String, required: true },
          inputMessageId: { type: String, required: true },
          expectedInputKind: {
            type: String,
            enum: GENERATIVE_AI_INPUT_KINDS,
            required: true,
          },
          mode: {
            type: String,
            enum: GENERATIVE_AI_ACTION_MODES,
            required: true,
          },
          composedPrompt: { type: String, required: true },
          imageConfig: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
          },
          sourceMedia: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                whatsappMediaId: { type: String, required: true },
                declaredMimeType: { type: String, default: null },
                fileName: { type: String, default: null },
              } satisfies Record<keyof GenerativeAISourceMedia, unknown>,
              { _id: false }
            ),
            default: null,
          },
          successTransition: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                nextActionNodeId: { type: String, default: null },
                completesScenario: { type: Boolean, required: true },
              } satisfies Record<keyof GenerativeAITransition, unknown>,
              { _id: false }
            ),
            required: true,
          },
          failureTransition: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                nextActionNodeId: { type: String, default: null },
                completesScenario: { type: Boolean, required: true },
              } satisfies Record<keyof GenerativeAITransition, unknown>,
              { _id: false }
            ),
            required: true,
          },
          scenarioWorkflowId: { type: String, required: true },
          videoWorkflowId: { type: String, default: undefined },
          acceptedAt: { type: String, required: true },
          assetId: { type: String, default: undefined },
          deliveryClaim: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                token: { type: String, required: true },
                kind: {
                  type: String,
                  enum: GENERATIVE_AI_RESULT_DELIVERY_KINDS,
                  required: true,
                },
                deliveryKey: { type: String, required: true },
                reservedMessageId: { type: String, required: true },
                claimedAt: { type: String, required: true },
                attemptToken: { type: String, default: null },
                attachment: {
                  type: new mongoose.Schema<Record<string, unknown>>(
                    {
                      url: { type: String, required: true },
                      mediaType: {
                        type: String,
                        enum: GENERATIVE_AI_DELIVERY_MEDIA_TYPES,
                        required: true,
                      },
                      mimeType: { type: String, required: true },
                      fileName: { type: String, required: true },
                      fileSize: { type: Number, required: true },
                      bucket: { type: String, required: true },
                      path: { type: String, required: true },
                    } satisfies Record<
                      keyof GenerativeAIDeliveryAttachment,
                      unknown
                    >,
                    { _id: false }
                  ),
                  default: null,
                },
              } satisfies Record<keyof GenerativeAIDeliveryClaim, unknown>,
              { _id: false }
            ),
            default: undefined,
          },
        } satisfies Record<keyof GenerativeAIExecution, unknown>,
        { _id: false }
      ),
      default: null,
    },
    // The last day's generation starts, for each node's daily limit.
    airi_generative_starts: {
      type: [
        new mongoose.Schema<Record<string, unknown>>(
          {
            scenarioId: { type: String, required: true },
            actionNodeId: { type: String, required: true },
            acceptedAt: { type: Date, required: true },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    airi_scenario_state: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          lockedScenarioId: { type: String, default: null },
          behaviorRunId: { type: String, default: null },
          lockedScenarioName: { type: String, default: null },
          currentActionNodeId: { type: String, default: null },
          scenarioRevisionFingerprint: { type: String, default: null },
          currentPathNodeIds: { type: [String], default: [] },
          currentBranchNodeIds: { type: [String], default: [] },
          pendingConditionNodeId: { type: String, default: null },
          pendingSourceActionNodeId: { type: String, default: null },
          pendingLegacyRouting: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                kind: {
                  type: String,
                  enum: ["interactive_no_reply_assignment"],
                  required: true,
                },
                conditionNodeId: { type: String, required: true },
                sourceActionNodeId: { type: String, required: true },
              },
              { _id: false }
            ),
            default: null,
          },
          pendingStartedAt: { type: Date, default: null },
          pendingScenarioUpdatedAt: { type: Date, default: null },
          pendingLastOutboundMessageId: { type: String, default: null },
          pendingLinkedConditionId: { type: String, default: null },
          lastMatchedAt: { type: Date, default: null },
          lastMessageId: { type: String, default: null },
          collectedPromptInputs: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                scenarioId: { type: String, required: true },
                sourceActionNodeId: { type: String, required: true },
                awaitingReply: { type: Boolean, default: false },
                resumeActionNodeId: { type: String, default: null },
                sourcePathNodeIds: { type: [String], default: [] },
                values: { type: mongoose.Schema.Types.Mixed, default: {} },
                followsChoice: { type: Boolean, default: false },
                choiceOptionId: { type: String, default: null },
                expiresAt: { type: Date, default: null },
                nudged: { type: Boolean, default: false },
              },
              { _id: false }
            ),
            default: null,
          },
          pickedOptions: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                scenarioId: { type: String, required: true },
                picks: {
                  type: [
                    new mongoose.Schema<Record<string, unknown>>(
                      {
                        sourceActionNodeId: { type: String, required: true },
                        optionId: { type: String, required: true },
                        label: { type: String, default: "" },
                        cardIndex: { type: Number },
                        cardId: { type: String },
                        cardBodyText: { type: String },
                        cardMedia: { type: mongoose.Schema.Types.Mixed },
                        pickedAt: { type: String, default: "" },
                      },
                      { _id: false }
                    ),
                  ],
                  default: [],
                },
              },
              { _id: false }
            ),
            default: null,
          },
          formAnswers: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                scenarioId: { type: String, required: true },
                submissions: {
                  type: [
                    new mongoose.Schema<Record<string, unknown>>(
                      {
                        sourceActionNodeId: { type: String, required: true },
                        flowId: { type: String, default: null },
                        inboundMessageId: { type: String, default: "" },
                        submittedAt: { type: String, default: "" },
                        fields: {
                          type: [
                            new mongoose.Schema<Record<string, unknown>>(
                              {
                                key: { type: String, required: true },
                                label: { type: String, default: "" },
                                fieldType: { type: String, default: "unknown" },
                                value: { type: String, default: "" },
                              },
                              { _id: false }
                            ),
                          ],
                          default: [],
                        },
                      },
                      { _id: false }
                    ),
                  ],
                  default: [],
                },
              },
              { _id: false }
            ),
            default: null,
          },
          // Shared locations the scenario decided, with the office each found.
          routedLocations: {
            type: new mongoose.Schema<Record<string, unknown>>(
              {
                scenarioId: { type: String, required: true },
                entries: {
                  type: [
                    new mongoose.Schema<Record<string, unknown>>(
                      {
                        sourceActionNodeId: { type: String, required: true },
                        inboundMessageId: { type: String, required: true },
                        sharedAt: { type: String, default: "" },
                        decidedAt: { type: String, default: "" },
                        source: { type: String, default: "turn" },
                        outcome: { type: String, required: true },
                        routeId: { type: String },
                        office: { type: mongoose.Schema.Types.Mixed },
                        distanceMeters: { type: Number },
                        reason: { type: String },
                      },
                      { _id: false }
                    ),
                  ],
                  default: [],
                },
              },
              { _id: false }
            ),
            default: null,
          },
          startedScenarios: {
            type: [
              new mongoose.Schema<Record<string, unknown>>(
                {
                  scenarioId: { type: String, required: true },
                  scenarioName: { type: String, default: null },
                  startedAt: { type: Date, required: true },
                  firstActionNodeId: { type: String, default: null },
                  firstMessageId: { type: String, default: null },
                },
                { _id: false }
              ),
            ],
            default: [],
          },
          completedScenarios: {
            type: [
              new mongoose.Schema<Record<string, unknown>>(
                {
                  scenarioId: { type: String, required: true },
                  scenarioName: { type: String, default: null },
                  completedAt: { type: Date, required: true },
                  lastActionNodeId: { type: String, default: null },
                  lastMessageId: { type: String, default: null },
                },
                { _id: false }
              ),
            ],
            default: [],
          },
        },
        { _id: false }
      ),
      default: null,
    },
    // Legacy field for backward compatibility - will be migrated
    airi_enabled: { type: Boolean, default: undefined },

    // Preferred language for this conversation (auto-detected from customer messages)
    preferred_language: {
      type: String,
      enum: CONVERSATION_PREFERRED_LANGUAGES,
      default: "en",
    },
    airi_last_customer_language: {
      type: String,
      enum: CONVERSATION_PREFERRED_LANGUAGES,
      default: null,
    },
    airi_last_customer_language_at: {
      type: Date,
      default: null,
    },
    airi_last_customer_language_source: {
      type: String,
      enum: CONVERSATION_CUSTOMER_LANGUAGE_SOURCES,
      default: null,
    },

    // Web widget specific fields
    // Page URL this conversation is associated with (for grouping multi-URL conversations)
    page_url: {
      type: String,
      default: null,
    },
    // Visitor ID for grouping conversations across URLs (web_widget channel only)
    visitor_id: {
      type: String,
      default: null,
    },

    // Bulk campaign tracking
    internal_labels: { type: [String], default: [] },
    last_bulk_sent_at: { type: Date, default: null },
    whatsapp_opt_in: {
      status: { type: Boolean, default: false },
      source: { type: String, default: null },
      updatedAt: { type: Date, default: null },
      signupLinkId: { type: String, default: null },
      metaSignupId: { type: String, default: null },
      messagingCustomerBaseId: { type: String, default: null },
      productLine: { type: String, default: null },
      shop: { type: String, default: null },
      campaign: { type: String, default: null },
      landingPage: { type: String, default: null },
      ad: { type: String, default: null },
      checkoutFlow: { type: String, default: null },
    },
    // First-touch CTWA (Click-to-WhatsApp) ad attribution. Populated on the
    // first inbound message when Meta includes a `referral` object; not
    // overwritten on subsequent messages so attribution survives reopens.
    whatsappReferral: {
      sourceType: { type: String, default: null },
      sourceId: { type: String, default: null },
      sourceUrl: { type: String, default: null },
      campaignId: { type: String, default: null },
      campaignName: { type: String, default: null },
      adSetId: { type: String, default: null },
      adSetName: { type: String, default: null },
      headline: { type: String, default: null },
      body: { type: String, default: null },
      mediaType: { type: String, default: null },
      imageUrl: { type: String, default: null },
      videoUrl: { type: String, default: null },
      thumbnailUrl: { type: String, default: null },
      ctwaClid: { type: String, default: null },
      ref: { type: String, default: null },
      welcomeMessageText: { type: String, default: null },
      capturedAt: { type: Date, default: null },
      adAccountId: { type: String, default: null },
      campaignLabels: {
        type: [
          new mongoose.Schema<Record<string, unknown>>(
            {
              id: { type: String, required: true },
              name: { type: String, default: null },
            },
            { _id: false }
          ),
        ],
        default: undefined,
      },
      campaignLabelStatus: {
        type: String,
        enum: ["present", "absent", "unavailable"],
        default: undefined,
      },
    },
    // We can store a history of campaign nodes executed for this user to avoid re-sending the same node
    bulk_campaign_history: [
      {
        scheduleId: {
          type: mongoose.Schema.Types.ObjectId,
        },
        scenarioId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Scenario",
        },
        nodeId: { type: String }, // The ID of the node in the flow
        sentAt: { type: Date, default: Date.now },
        templateName: { type: String },
        labelApplied: { type: String }, // The internal label applied after sending (next step)
      },
    ],

    /** Cached follow-up audience analysis snapshot retained for reuse/backfill compatibility. */
    followUpAudience: {
      type: new mongoose.Schema<Record<string, unknown>>(
        {
          analyzedAt: { type: Date, default: null },
          status: { type: String, default: null },
          effectiveCategory: { type: String, default: null },
          /** `normalizeText(effectiveCategory)` for snapshot queries aligned with in-memory filters. */
          effectiveCategoryKey: { type: String, default: null },
          categorySource: { type: String, default: null },
          categoryConfidence: { type: Number, default: null },
          categoryEvidence: { type: String, default: null },
          purchaseAt: { type: String, default: null },
          purchaseEvidenceType: { type: String, default: null },
          readyAt: { type: String, default: null },
          warnings: { type: [String], default: [] },
          chatLabel: { type: String, default: null },
          startedScenarioIds: { type: [String], default: [] },
          recommendedRootScenarioId: { type: String, default: null },
          recommendedRootScenarioName: { type: String, default: null },
          currentFollowUpScenarioName: { type: String, default: null },
          taxonomyVersion: { type: String, default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    embedding: {
      type: [Number],
    },
    embeddingProvider: {
      type: String,
      enum: ["vertex", "openai"],
    },
    embeddingModel: {
      type: String,
    },
    embeddingTaskType: {
      type: String,
      enum: ["RETRIEVAL_DOCUMENT"],
    },
    embeddingDimensions: {
      type: Number,
    },
  },
  { timestamps: true }
);

ConversationSchema.post("init", function repairHydratedLanguageState(doc) {
  const preferredLanguageSelected = doc.isSelected("preferred_language");
  const recentLanguageSelected = doc.isSelected("airi_last_customer_language");
  const recentLanguage = recentLanguageSelected
    ? normalizeConversationPreferredLanguage(doc.airi_last_customer_language)
    : null;
  const preferredLanguage = preferredLanguageSelected
    ? normalizeConversationPreferredLanguage(doc.preferred_language)
    : null;

  if (preferredLanguageSelected) {
    if (preferredLanguage) {
      if (doc.preferred_language !== preferredLanguage) {
        doc.set("preferred_language", preferredLanguage);
      }
    } else if (recentLanguageSelected) {
      // A projected document cannot safely infer a fallback from an omitted
      // recent language. Repair only when both inputs are known.
      doc.set("preferred_language", recentLanguage || "en");
    }
  }

  if (
    recentLanguageSelected &&
    doc.airi_last_customer_language !== recentLanguage
  ) {
    doc.set("airi_last_customer_language", recentLanguage);
    if (!recentLanguage) {
      // These fields form one invariant even when the query omitted metadata.
      doc.set("airi_last_customer_language_at", null);
      doc.set("airi_last_customer_language_source", null);
    }
  }
});

const SERVICE_LIFECYCLE_SNAPSHOT_FIELDS = [
  "_id",
  "workspaceId",
  "customerId",
  "sourceId",
  "channel",
  "status",
  "airi_handoff_active",
  "airi_handoff_started_at",
  "first_inbound_at",
  "csat_timeout_closed",
  "service_episode_started_at",
  "service_closed_at",
  "service_resolved_at",
  "service_resolution_kind",
  "service_lifecycle_revision",
] as const;
function serviceLifecycleSnapshot(document: {
  get(path: string): unknown;
}): ServiceLifecycleSnapshot {
  return Object.fromEntries(
    SERVICE_LIFECYCLE_SNAPSHOT_FIELDS.map(key => [key, document.get(key)])
  ) as ServiceLifecycleSnapshot;
}
function serviceLifecycleFence(
  before: ServiceLifecycleSnapshot
): Record<string, unknown> {
  const revision = before.service_lifecycle_revision ?? 0;
  return revision === 0
    ? {
        $or: [
          { service_lifecycle_revision: 0 },
          { service_lifecycle_revision: { $exists: false } },
        ],
      }
    : { service_lifecycle_revision: revision };
}
ConversationSchema.post("init", function captureServiceLifecycleBaseline(doc) {
  if (SERVICE_LIFECYCLE_SNAPSHOT_FIELDS.every(key => doc.isSelected(key)))
    doc.$locals.serviceLifecycleBefore = serviceLifecycleSnapshot(doc);
});
ConversationSchema.pre(
  "save",
  async function captureServiceLifecycleTransition() {
    if (
      !this.isNew &&
      !this.isModified("status") &&
      !this.isModified("airi_handoff_active")
    )
      return;
    let before = this.isNew
      ? null
      : (this.$locals.serviceLifecycleBefore as
          | ServiceLifecycleSnapshot
          | undefined);
    if (!this.isNew && !before) {
      before = (await mongoose
        .model("Conversation")
        .findById(this._id)
        .select(SERVICE_LIFECYCLE_SNAPSHOT_FIELDS.join(" "))
        .session(this.$session())
        .lean()) as ServiceLifecycleSnapshot | null;
      if (!before)
        throw new Error("Conversation lifecycle source no longer exists");
    }
    const current = Object.fromEntries(
      SERVICE_LIFECYCLE_SNAPSHOT_FIELDS.filter(
        key => this.isSelected(key) || this.isModified(key)
      ).map(key => [key, this.get(key)])
    );
    const transition = buildServiceLifecycleTransition({
      before: before ?? null,
      after: { ...before, ...current },
      now: new Date(),
      eventId: randomUUID(),
      resolutionKind: this.$locals.serviceResolutionKind as
        | ServiceResolutionKind
        | undefined,
    });
    if (!transition) return;
    if (before)
      this.$where = { ...this.$where, ...serviceLifecycleFence(before) };
    this.set(transition);
  }
);
ConversationSchema.post("save", function advanceServiceLifecycleBaseline(doc) {
  doc.$locals.serviceLifecycleBefore = serviceLifecycleSnapshot(doc);
  delete doc.$locals.serviceResolutionKind;
  doc.$where = {};
});

type ServiceLifecycleQuery = mongoose.Query<unknown, unknown> & {
  $locals?: { serviceLifecycleFenced?: boolean };
};
ConversationSchema.pre(
  ["updateOne", "findOneAndUpdate"],
  async function captureQueryServiceLifecycleTransition() {
    const update = this.getUpdate();
    if (!update || Array.isArray(update)) return;
    const values = (update.$set ?? update) as Record<string, unknown>;
    const unset = update.$unset as Record<string, unknown> | undefined;
    if (
      !("status" in values) &&
      !("airi_handoff_active" in values) &&
      !(unset && "airi_handoff_active" in unset)
    )
      return;
    const read = this.model
      .findOne(this.getQuery())
      .select(SERVICE_LIFECYCLE_SNAPSHOT_FIELDS.join(" "))
      .lean();
    const session = this.getOptions().session as ClientSession | undefined;
    if (session) read.session(session);
    const before = (await read) as ServiceLifecycleSnapshot | null;
    if (!before) return;
    const after = {
      ...before,
      ...values,
      ...(unset && "airi_handoff_active" in unset
        ? { airi_handoff_active: false }
        : {}),
    };
    const requestedKind = values.service_resolution_kind;
    const transition = buildServiceLifecycleTransition({
      before,
      after,
      now: new Date(),
      eventId: randomUUID(),
      resolutionKind: SERVICE_RESOLUTION_KINDS.includes(
        requestedKind as ServiceResolutionKind
      )
        ? (requestedKind as ServiceResolutionKind)
        : undefined,
    });
    if (!transition) {
      // A late or repeated CSAT answer can update the score without rewriting an earlier closure's truth.
      if (before.status === "closed" && after.status === "closed") {
        delete values.service_resolution_kind;
        delete values.csat_timeout_closed;
        this.setUpdate(update.$set ? { ...update, $set: values } : values);
      }
      return;
    }
    this.setQuery({
      $and: [
        this.getQuery(),
        { _id: before._id },
        serviceLifecycleFence(before),
      ],
    });
    this.setUpdate(
      Object.keys(update).some(key => key.startsWith("$"))
        ? { ...update, $set: { ...values, ...transition } }
        : { $set: { ...values, ...transition } }
    );
    const query = this as ServiceLifecycleQuery;
    query.$locals = { ...query.$locals, serviceLifecycleFenced: true };
  }
);
ConversationSchema.post(
  ["updateOne", "findOneAndUpdate"],
  function rejectLostServiceLifecycleTransition(result: unknown) {
    if (!(this as ServiceLifecycleQuery).$locals?.serviceLifecycleFenced)
      return;
    if (
      result === null ||
      (typeof result === "object" &&
        result &&
        "matchedCount" in result &&
        result.matchedCount === 0)
    )
      throw new ConversationLifecycleWriteConflictError();
  }
);

// Workspace-scoped indexes.
// Keep index definitions explicit here (compound/partial) to avoid index sprawl
// from many low-selectivity single-field indexes.

export const CONVERSATION_OFFLINE_EVAL_INDEX = {
  keys: { createdAt: 1 },
  options: {
    name: "conversations_offline_eval_created_v1",
    partialFilterExpression: {
      "classification.category": { $exists: true },
      "shadow_classification.category": { $exists: true },
    },
  },
} as const;
ConversationSchema.index(
  CONVERSATION_OFFLINE_EVAL_INDEX.keys,
  CONVERSATION_OFFLINE_EVAL_INDEX.options
);

// User/Chat changes fan out across workspaces in stable _id pages. Mixed IDs
// must stay fully indexed, including legacy numeric and ObjectId references.
export const CONVERSATION_REQUESTS_DEPENDENCY_INDEXES = [
  {
    keys: { user: 1, _id: 1 },
    options: { name: "conversations_requests_user_id_v1" },
  },
  {
    keys: { chat: 1, _id: 1 },
    options: { name: "conversations_requests_chat_id_v1" },
  },
] as const;
for (const definition of CONVERSATION_REQUESTS_DEPENDENCY_INDEXES) {
  ConversationSchema.index(definition.keys, definition.options);
}

export const CONVERSATION_REQUESTS_BACKFILL_INDEX_NAME =
  "conversations_workspace_id_asc_v1";
export const CONVERSATION_REQUESTS_BACKFILL_INDEX_KEYS = {
  workspaceId: 1,
  _id: 1,
} as const;

ConversationSchema.index(CONVERSATION_REQUESTS_BACKFILL_INDEX_KEYS, {
  name: CONVERSATION_REQUESTS_BACKFILL_INDEX_NAME,
});

export const CONVERSATION_VISIBILITY_GATE_INDEX_NAME =
  "conversations_workspace_created_id_asc_v1";
export const CONVERSATION_VISIBILITY_GATE_INDEX_KEYS = {
  workspaceId: 1,
  createdAt: 1,
  _id: 1,
} as const;

ConversationSchema.index(CONVERSATION_VISIBILITY_GATE_INDEX_KEYS, {
  name: CONVERSATION_VISIBILITY_GATE_INDEX_NAME,
});

export const CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME =
  "conversations_workspace_scenario_pending_wait_v2";
export const CONVERSATION_SCENARIO_PENDING_WAIT_LEGACY_INDEX_NAME =
  "conversations_workspace_scenario_pending_wait";
export const CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS = {
  workspaceId: 1,
  "airi_scenario_state.lockedScenarioId": 1,
  "airi_scenario_state.pendingConditionNodeId": 1,
  "airi_scenario_state.pendingSourceActionNodeId": 1,
} as const;
export const CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER = {
  "airi_scenario_state.lockedScenarioId": { $type: "string" },
  "airi_scenario_state.pendingConditionNodeId": { $type: "string" },
} as const;

ConversationSchema.index(CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_KEYS, {
  name: CONVERSATION_SCENARIO_PENDING_WAIT_INDEX_NAME,
  partialFilterExpression: CONVERSATION_SCENARIO_PENDING_WAIT_PARTIAL_FILTER,
});

ConversationSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
ConversationSchema.index({ workspaceId: 1, status: 1, lastMessageAt: -1 });
ConversationSchema.index({ workspaceId: 1, createdAt: -1 });
ConversationSchema.index({ workspaceId: 1, updatedAt: 1, _id: 1 });
ConversationSchema.index({ workspaceId: 1, channel: 1, createdAt: -1 });
ConversationSchema.index({ workspaceId: 1, lastMessageAt: -1 });
ConversationSchema.index({
  workspaceId: 1,
  is_read_by_manager: 1,
  lastMessageAt: -1,
});
ConversationSchema.index({ workspaceId: 1, chat: 1, createdAt: -1 });
// Performance indexes for mission-control
ConversationSchema.index({ workspaceId: 1, "classification.category": 1 });
ConversationSchema.index({ workspaceId: 1, internal_labels: 1 });
ConversationSchema.index({ workspaceId: 1, channel: 1, user: 1 });
ConversationSchema.index({ workspaceId: 1, user: 1, lastMessageAt: -1 });
// Index for finding business conversations by connection ID
ConversationSchema.index({
  workspaceId: 1,
  business_connection_id: 1,
  chat: 1,
});
// Index for finding web_widget conversations by visitor + URL
ConversationSchema.index({
  workspaceId: 1,
  visitor_id: 1,
  page_url: 1,
  status: 1,
});
// Index for finding all conversations for a visitor (cross-URL)
ConversationSchema.index({
  workspaceId: 1,
  visitor_id: 1,
  channel: 1,
  lastMessageAt: -1,
});

// CTWA attribution reporting - partial index to avoid bloating the index for
// the majority of non-ad conversations.
ConversationSchema.index(
  { workspaceId: 1, "whatsappReferral.sourceId": 1, lastMessageAt: -1 },
  {
    partialFilterExpression: {
      "whatsappReferral.sourceId": { $type: "string" },
    },
  }
);
export const CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME =
  "conversations_workspace_channel_instagram_referral_ad_last_message";
export const CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS = {
  workspaceId: 1,
  channel: 1,
  "external_thread.referral.adId": 1,
  lastMessageAt: -1,
} as const;
export const CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER = {
  "external_thread.referral.adId": { $type: "string" },
} as const;

ConversationSchema.index(CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_KEYS, {
  name: CONVERSATION_INSTAGRAM_REFERRAL_AD_INDEX_NAME,
  partialFilterExpression: CONVERSATION_INSTAGRAM_REFERRAL_AD_PARTIAL_FILTER,
});
// Campaign automation and preview query indexes
ConversationSchema.index({ workspaceId: 1, channel: 1, lastMessageAt: -1 });
ConversationSchema.index({
  workspaceId: 1,
  channel: 1,
  "bulk_campaign_history.scheduleId": 1,
  "bulk_campaign_history.scenarioId": 1,
  "bulk_campaign_history.nodeId": 1,
  "bulk_campaign_history.sentAt": -1,
});
ConversationSchema.index({ workspaceId: 1, customerId: 1, lastMessageAt: -1 });

export const CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME =
  "conversations_workspace_channel_source_chat_updated_desc";
ConversationSchema.index(CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC.keys, CONVERSATION_WHATSAPP_IDENTITY_INDEX_SPEC.options);
ConversationSchema.index(CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC.keys, CONVERSATION_WHATSAPP_ALIAS_INDEX_SPEC.options);
export const CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS = {
  workspaceId: 1,
  channel: 1,
  sourceId: 1,
  chat: 1,
  updatedAt: -1,
} as const;
export const CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME =
  "conversations_workspace_channel_source_user_updated_desc";
export const CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS = {
  workspaceId: 1,
  channel: 1,
  sourceId: 1,
  user: 1,
  updatedAt: -1,
} as const;
export const CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_NAME =
  "conversations_workspace_channel_source_group_updated_desc";
export const CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_KEYS = {
  workspaceId: 1,
  channel: 1,
  sourceId: 1,
  "whatsappGroup.groupId": 1,
  updatedAt: -1,
} as const;

ConversationSchema.index(CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_KEYS, {
  name: CONVERSATION_WHATSAPP_SOURCE_CHAT_LOOKUP_INDEX_NAME,
});
ConversationSchema.index(CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_KEYS, {
  name: CONVERSATION_WHATSAPP_SOURCE_USER_LOOKUP_INDEX_NAME,
});
ConversationSchema.index(CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_KEYS, {
  name: CONVERSATION_WHATSAPP_SOURCE_GROUP_LOOKUP_INDEX_NAME,
  partialFilterExpression: { "whatsappGroup.groupId": { $type: "string" } },
});

export const CONVERSATION_CLASSIFICATION_QUEUE_LEGACY_INDEX_NAME =
  "conversations_unclassified_inbound_classification_queue";
export const CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME =
  "conversations_classification_pending_due";
export const CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS = {
  "classification_state.status": 1,
  "classification_state.nextAttemptAt": 1,
  "classification_state.requestedAt": 1,
  _id: 1,
} as const;
export const CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER = {
  "classification_state.contractVersion":
    CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
  "classification_state.status": { $in: ["pending", "blocked"] },
} as const;
export const CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME =
  "conversations_classification_processing_lease_expired";
export const CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS = {
  "classification_state.status": 1,
  "classification_state.lease.expiresAt": 1,
  _id: 1,
} as const;
export const CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER = {
  "classification_state.contractVersion":
    CONVERSATION_CLASSIFICATION_STATE_CONTRACT_VERSION,
  "classification_state.status": "processing",
} as const;

export const CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME =
  "conversations_workspace_first_inbound_first_response";
export const CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS = {
  workspaceId: 1,
  first_inbound_at: 1,
  first_response_seconds: 1,
} as const;

// Denormalized message-timestamp indexes for analytics filters that need to
// avoid joining back into messages for dashboard reads.
ConversationSchema.index(CONVERSATION_CLASSIFICATION_PENDING_INDEX_KEYS, {
  name: CONVERSATION_CLASSIFICATION_PENDING_INDEX_NAME,
  partialFilterExpression: CONVERSATION_CLASSIFICATION_PENDING_PARTIAL_FILTER,
});
ConversationSchema.index(CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_KEYS, {
  name: CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_INDEX_NAME,
  partialFilterExpression:
    CONVERSATION_CLASSIFICATION_EXPIRED_LEASE_PARTIAL_FILTER,
});
ConversationSchema.index(CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_KEYS, {
  name: CONVERSATION_FIRST_RESPONSE_ANALYTICS_INDEX_NAME,
});
ConversationSchema.index({
  workspaceId: 1,
  channel: 1,
  last_inbound_at: -1,
});
ConversationSchema.pre("save", function syncMessageCount() {
  this.$locals.wasNewForUsageCounter = this.isNew;
  if (this.isNew || this.isModified("messages")) {
    const messages = Array.isArray(this.messages) ? this.messages : [];
    this.message_count = messages.length;
  }
});

ConversationSchema.post("save", function postSaveSyncCustomer(doc) {
  if (!doc?._id) {
    return;
  }

  setImmediate(async () => {
    try {
      const { syncCustomerForConversation } = await import(
        "@/lib/customers/service"
      );
      await syncCustomerForConversation({
        conversationId: String(doc._id),
      });
    } catch {
      // Non-blocking best effort.
    }
  });
});

ConversationSchema.post("save", function postSaveEmitUsageCounter(doc) {
  if (!doc?.$locals?.wasNewForUsageCounter || !doc.workspaceId) {
    return;
  }

  setImmediate(async () => {
    try {
      const { emitWorkspaceUsageDeltaBestEffort } = await import(
        "@/lib/limits/company-usage-events"
      );
      emitWorkspaceUsageDeltaBestEffort(
        {
          workspaceId: String(doc.workspaceId),
          metric: "conversation_count",
          delta: 1,
          objectId: String(doc._id),
          source: "conversation_model",
          metadata: {
            sourceType:
              typeof doc.channel === "string" ? doc.channel : undefined,
          },
        },
        { logContext: "Conversation.postSave" }
      );
    } catch {
      // Non-blocking best effort.
    }
  });
});

export const CONVERSATION_ENGAGEMENT_BOOTSTRAP_INDEX_SPEC = {
  keys: {
    "engagement_accumulator.phase": 1,
    "engagement_accumulator.leaseUntil": 1,
    _id: 1,
  },
  options: {
    name: "engagement_bootstrap_lease_v1",
    partialFilterExpression: { "engagement_accumulator.phase": "building" },
  },
} as const;
ConversationSchema.index(
  CONVERSATION_ENGAGEMENT_BOOTSTRAP_INDEX_SPEC.keys,
  CONVERSATION_ENGAGEMENT_BOOTSTRAP_INDEX_SPEC.options
);

ConversationSchema.set("toJSON", { transform: stripPrivateEngagementState });
ConversationSchema.set("toObject", { transform: stripPrivateEngagementState });

export const Conversation =
  mongoose.models.Conversation ||
  mongoose.model("Conversation", ConversationSchema);
