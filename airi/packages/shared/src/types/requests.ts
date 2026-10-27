import type {
  RequestConversationMessage,
  RequestConversationMessageAuthor,
  StoredMessageEditMeta,
} from "./message-preview";
import type { Channel } from "./sources";

export type ObjectIdLike = { toString(): string };
export type RawId = string | number | ObjectIdLike;
export type RawDate = Date | string;
export type NullableRawDate = RawDate | null | undefined;

export type RawRequestConversationMessageAuthor = Omit<
  RequestConversationMessageAuthor,
  "_id"
> & {
  _id?: RawId;
};

export type RawRequestConversationMessage = Omit<
  RequestConversationMessage,
  "author" | "date" | "editMeta"
> & {
  _id?: RawId;
  author?: RawRequestConversationMessageAuthor;
  date?: RawDate;
  editMeta?:
    | (Omit<StoredMessageEditMeta, "editedAt"> & {
        editedAt?: NullableRawDate;
      })
    | null;
};

export interface InstagramRequestMeta {
  isReply?: boolean;
  isHidden?: boolean;
  likeCount?: number | null;
  mediaType?: string;
  mediaProductType?: string;
  mediaCaption?: string;
  mediaPreviewUrl?: string;
  mediaAuthorUsername?: string;
}

export interface InstagramReferralRequestMeta {
  source?: string;
  type?: string;
  ref?: string;
  adId?: string;
  productId?: string;
  productRetailerId?: string;
  title?: string;
  body?: string;
  mediaUrl?: string;
  sourceUrl?: string;
}

export interface FormattedRequest {
  id: string;
  projectionGeneration: string;
  readStateWatermark: string;
  dateValue: string;
  source: string;
  status: string;
  client: string;
  rename?: string | null;
  /** Email subject or classification summary; null when there is none. */
  request: string | null;
  category: string | null;
  /** Classification's recommended next action. */
  action: string | null;
  channel?: string;
  lastInboundMessageAt?: string | null;
  avatarUrl?: string;
  lastMessageText?: string;
  lastMessageAuthor?: string;
  lastMessageDirection?: string;
  lastMessageThreadId?: number | null;
  lastMessages?: RequestConversationMessage[];
  chatType?: string;
  awaitingCsat?: boolean;
  customerSatisfactionScore?: number | null;
  airiLastReplied?: boolean;
  isReadByManager?: boolean;
  isInstagramCommentThread?: boolean;
  instagramMeta?: InstagramRequestMeta;
  internalLabels?: string[];
}

export interface RawConversation {
  _id: RawId;
  projectionGeneration: string;
  readStateWatermark: string;
  createdAt: RawDate;
  channel?: Channel;
  business_connection_id?: string;
  internal_labels?: string[];
  subject?: string | null;
  rename?: string | null;
  participants?: { from: string[]; to: string[] };
  chat?: {
    _id?: RawId;
    title?: string;
    type?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
    sourceId?: string;
    is_forum?: boolean;
  } | null;
  status: string;
  user?: {
    _id?: RawId;
    username?: string;
    firstName?: string;
    lastName?: string;
    avatar_url?: string;
  } | null;
  awaiting_csat?: boolean;
  customer_satisfaction_score?: number | null;
  classification?: {
    summary?: string;
    category?: string;
    priority?: string;
    action?: string;
  };
  lastInboundMessageAt?: NullableRawDate;
  computedLastMessageAt?: RawDate;
  is_read_by_manager?: boolean;
  airiLastReplied?: boolean;
  external_thread?: {
    provider?: string;
    type?: string;
    threadId?: string;
    permalink?: string;
    comment?: {
      id?: string;
      timestamp?: RawDate;
      parentId?: string;
      hidden?: boolean;
      likeCount?: number;
    } | null;
    media?: {
      id?: string;
      mediaType?: string;
      mediaProductType?: string;
      shortcode?: string;
      timestamp?: RawDate;
      caption?: string;
      mediaUrl?: string;
      thumbnailUrl?: string;
      username?: string;
    } | null;
    referral?: InstagramReferralRequestMeta | null;
  } | null;
  sourceInfo?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  lastMessageText?: string;
  messages?: RawRequestConversationMessage[];
}
