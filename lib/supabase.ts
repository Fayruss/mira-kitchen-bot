// supabase.ts
// Responsibility: create the Supabase client used by any service that
// reads/writes conversation_sessions or orders.
//
// Uses the service role key since all access happens server-side, inside
// Next.js API routes — never exposed to the browser. Lazily created so a
// missing env var only fails the request that needs it, not the whole
// module graph.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (client) {
    return client;
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  client = createClient(url, serviceRoleKey);
  return client;
}
