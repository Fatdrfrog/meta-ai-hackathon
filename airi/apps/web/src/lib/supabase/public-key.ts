import { validateSupabasePublicKey } from "../../../../../packages/shared/src/supabase/public-key-validation.cjs";

export { validateSupabasePublicKey };

export function getSupabasePublicKey(): string {
  return validateSupabasePublicKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
