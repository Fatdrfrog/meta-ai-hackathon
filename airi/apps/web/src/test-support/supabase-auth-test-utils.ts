// supabase-js auth doubles for route suites that mock createClient.

type AuthUser = Record<string, unknown> | null;

/**
 * An auth double whose getUser is a recording jest.fn resolving `user`.
 * withSession adds a plain getSession that resolves a null session.
 */
export function supabaseAuth(
  user: AuthUser = { id: "user-1" },
  { withSession = false }: { withSession?: boolean } = {}
) {
  return {
    ...(withSession
      ? { getSession: async () => ({ data: { session: null } }) }
      : {}),
    getUser: jest.fn(async () => ({ data: { user } })),
  };
}

/** Resolve a mocked createClient to `{ auth }` and return that client. */
export function mockSupabaseUser(
  createClient: jest.Mock,
  user?: AuthUser,
  options?: { withSession?: boolean }
) {
  const supabase = { auth: supabaseAuth(user, options) };
  createClient.mockResolvedValue(supabase);
  return supabase;
}
