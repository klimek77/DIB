// Request-less, service-role Supabase client for the enrichment consumer. Uses the
// raw @supabase/supabase-js `createClient` — NOT @supabase/ssr (src/lib/supabase.ts),
// which is cookie/request-bound and unusable from a queue handler that has no request.
//
// The service-role key bypasses RLS and the column grants that deliberately withhold
// enrichment_*/ai_* from anon/authenticated (migration 20260528000000:143-146) — this
// is the intended write path for the consumer. Session persistence and token refresh
// are disabled: a worker has no browser storage and no user session to keep.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../database.types";

export function createAdminClient(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
