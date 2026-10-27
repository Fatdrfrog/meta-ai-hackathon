// The real auth context loads the Supabase browser client, whose CommonJS key
// check Vite cannot serve. The page mounts no AuthProvider, so the real
// useOptionalAuth would return undefined too: the session cache stays shared.
export function useOptionalAuth(): undefined {
  return undefined;
}
