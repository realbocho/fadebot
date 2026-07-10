import { createClient } from "@supabase/supabase-js";

let _db;
export function db() {
  if (!_db) {
    _db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY, // server-only
      { auth: { persistSession: false } }
    );
  }
  return _db;
}
