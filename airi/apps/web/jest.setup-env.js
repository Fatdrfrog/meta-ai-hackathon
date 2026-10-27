// Modules that create the Supabase admin client at import time need a URL and
// key to load. Suites mock every call; these placeholders only apply when no
// .env.local provides real values (CI, fresh worktrees).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
