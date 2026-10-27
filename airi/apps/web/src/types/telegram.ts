import type { TelegramChatType } from "@icecore/shared/types/telegram";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  added_to_attachment_menu?: boolean;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramChat {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}

export interface TelegramDocument extends TelegramFile {
  file_name?: string;
  mime_type?: string;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramAudio extends TelegramFile {
  duration?: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramVoice extends TelegramFile {
  duration?: number;
  mime_type?: string;
}

export interface TelegramVideo extends TelegramFile {
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramVideoNote extends TelegramFile {
  length?: number;
  duration?: number;
}

export interface TelegramAnimation extends TelegramFile {
  width?: number;
  height?: number;
  duration?: number;
  file_name?: string;
  mime_type?: string;
  thumbnail?: TelegramPhotoSize;
}

export interface TelegramSticker extends TelegramFile {
  type?: string;
  width?: number;
  height?: number;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
  set_name?: string;
}

export interface TelegramMessageEntity {
  offset: number;
  length: number;
  type: string;
  url?: string;
  user?: TelegramUser;
  language?: string;
  custom_emoji_id?: string;
}

export interface TelegramReplyMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  author_signature?: string;
  sender_tag?: string;
  date?: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}

export interface TelegramBotBusinessConnection {
  id: string;
  user_id?: number; // Legacy fallback
  user?: TelegramUser;
  user_chat_id?: number | string | null;
  date?: number;
  can_reply?: boolean; // Legacy fallback
  is_enabled?: boolean; // Legacy fallback
  rights?: {
    can_reply?: boolean;
    [key: string]: unknown;
  };
  dc_id?: number;
  disabled?: boolean;
  business_connection_id?: string;
  [key: string]: unknown;
}

interface TelegramBusinessMessage {
  business_connection_id: string;
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
}

interface TelegramBusinessMessagesDeleted {
  business_connection_id: string;
  chat: TelegramChat;
  message_ids: number[];
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date: number;
  edit_date?: number;
  forward_date?: number;
  text?: string;
  author_signature?: string;
  sender_tag?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  entities?: TelegramMessageEntity[];
  caption?: string;
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  animation?: TelegramAnimation;
  sticker?: TelegramSticker;
  reply_to_message?: TelegramReplyMessage;
  business_connection_id?: string;
  bot_business_connection?: TelegramBotBusinessConnection;
  business_message?: TelegramBusinessMessage;
  reply_markup?: {
    inline_keyboard: Array<
      Array<{ text: string; callback_data?: string; url?: string }>
    >;
  };
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance?: string;
  data?: string;
  game_short_name?: string;
}

export interface TelegramChatMember {
  user: TelegramUser;
  status:
    | "creator"
    | "administrator"
    | "member"
    | "restricted"
    | "left"
    | "kicked";
  custom_title?: string;
  is_anonymous?: boolean;
  can_be_edited?: boolean;
  can_manage_chat?: boolean;
  can_post_messages?: boolean;
  can_edit_messages?: boolean;
  can_delete_messages?: boolean;
  can_manage_video_chats?: boolean;
  can_restrict_members?: boolean;
  can_promote_members?: boolean;
  can_change_info?: boolean;
  can_invite_users?: boolean;
  can_pin_messages?: boolean;
  until_date?: number;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  date: number;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
  invite_link?: {
    creator: TelegramUser;
    creates_join_request: boolean;
    is_primary: boolean;
    is_revoked: boolean;
    name?: string;
    expiration_date?: number;
    member_limit?: number;
    pending_join_request_count?: number;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  business_connection?: TelegramBotBusinessConnection;
  business_message?: TelegramBusinessMessage;
  edited_business_message?: TelegramBusinessMessage;
  deleted_business_messages?: TelegramBusinessMessagesDeleted;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  my_chat_member?: TelegramChatMemberUpdated;
}
