// FILE: lib/supabase.ts
import { createClient } from "@supabase/supabase-js";

function pickEnv(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim().length > 0) return String(v).trim();
  }
  return undefined;
}

function requireEnv(names: string[], hint: string): string {
  const v = pickEnv(names);
  if (!v) {
    throw new Error(
      `[ENV MISSING] Missing ${names.join(" OR ")}. ${hint}\n` +
        `Fix: Put it in .env.local (project root) then restart 'npm run dev'.`
    );
  }
  return v;
}

const SUPABASE_URL = requireEnv(
  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"],
  "Expected a value like https://xxxx.supabase.co"
);

const SUPABASE_ANON_KEY = requireEnv(
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"],
  "Use the 'anon public' key from Supabase Settings → API"
);

const SERVICE_ROLE_KEY = pickEnv(["SUPABASE_SERVICE_ROLE_KEY"]);

// Browser client (RLS applies)
export const supabaseBrowser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Server/admin client (service role preferred)
export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY || SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

if (!SERVICE_ROLE_KEY) {
  // Not throwing (app still works), but this explains common storage issues
  console.warn(
    "[WARN] SUPABASE_SERVICE_ROLE_KEY is not set. Some storage/admin operations may fail depending on bucket policies."
  );
}

// Backward compatible alias used by your code
export const supabase = supabaseAdmin;
