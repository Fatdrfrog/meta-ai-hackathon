import type { WorkspaceRole } from "@/lib/supabase/company-users";

export type Workspace = {
  id: string;
  name: string;
  created_at: string;
};

// Re-export shared types for convenience
export type {
  InstagramSource,
  PublicTelegramCredentials,
  Source,
  TelegramCredentials,
  WebWidgetCredentials,
  WhatsAppCredentials,
  WhatsAppCredentialFields,
} from "@icecore/shared/types/sources";

export {
  isInstagramSource,
  isTelegramSource,
  isWhatsAppSource,
} from "@icecore/shared/types/sources";

// users table schema (public.users)
// NOTE: Email is NOT stored here! Email is in company_users.email or auth.users.email
export type User = {
  id: string;
  avatar_url: string | null;
  full_name: string | null;
};

export type Member = {
  id: string | number;
  role: WorkspaceRole;
  user_id: string;
  email: string; // From company_users.email
  users: User[] | null; // Joined from users table (only has id, full_name, avatar_url)
};

export type TeamMembers = Member[];
