// FILE: app/api/websearch-test/route.ts
import { NextResponse } from "next/server";
import { webSearch } from "@/lib/websearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const provider = (process.env.WEBSEARCH_PROVIDER || "serpapi").toLowerCase();

  const evidence = await webSearch("Microsoft SQL Server 2014 end of support end of life", 5);

  if (!evidence) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        error:
          "No evidence returned. Check WEBSEARCH_PROVIDER + SERPAPI_API_KEY (or BING_SEARCH_KEY).",
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ok: true,
    provider: evidence.provider,
    retrieved_at: evidence.retrieved_at,
    resultsPreview: evidence.results.slice(0, 3),
  });
}
