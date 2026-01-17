// FILE: app/api/env-check/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    INNGEST_EVENT_KEY: !!process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: !!process.env.INNGEST_SIGNING_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    NVD_API_KEY: !!process.env.NVD_API_KEY,

    WEBSEARCH_PROVIDER: !!process.env.WEBSEARCH_PROVIDER,
    SERPAPI_API_KEY: !!(process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY),
    BING_SEARCH_KEY: !!process.env.BING_SEARCH_KEY,
    BING_SEARCH_ENDPOINT: !!process.env.BING_SEARCH_ENDPOINT,
  };

  return NextResponse.json({ ok: true, env });
}
