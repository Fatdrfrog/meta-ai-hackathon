import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Detects if a message sender is the business owner for a given business connection
 *
 * @param senderId - Telegram user ID of the message sender (from.id)
 * @param businessConnectionId - The business connection ID
 * @returns true if sender is the business owner, false otherwise
 */
export async function isBusinessOwner(
  senderId: number,
  businessConnectionId: string | undefined
): Promise<boolean> {
  if (!businessConnectionId) {
    return false;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("telegram_business_connections")
      .select("telegram_user_id")
      .eq("business_connection_id", businessConnectionId)
      .maybeSingle<{ telegram_user_id: number | null }>();

    if (error || !data || data.telegram_user_id === null) {
      return false;
    }

    const isOwner = data.telegram_user_id === senderId;

    return isOwner;
  } catch {
    return false;
  }
}
