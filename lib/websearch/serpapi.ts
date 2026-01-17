// FILE: lib/websearch/serpapi.ts
import { getJsonSafe } from "@/lib/http";
import type { WebSearchResponse } from "./types";

function clean(v: any) {
  return (v ?? "").toString().trim();
}

type SerpApiOrganic = { title?: string; link?: string; snippet?: string };
type SerpApiResponse = { organic_results?: SerpApiOrganic[] };

export async function serpApiSearch(query: string, maxResults = 5): Promise<WebSearchResponse | null> {
  const key = process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY || "";
  if (!key) return null;

  const p = new URLSearchParams();
  p.set("engine", "google");
  p.set("q", query);
  p.set("api_key", key);
  p.set("num", String(Math.min(10, Math.max(1, maxResults))));

  const url = `https://serpapi.com/search.json?${p.toString()}`;
  const resp = await getJsonSafe<SerpApiResponse>(url, { timeoutMs: 20000 });
  if (!resp.ok) return null;

  const organic = Array.isArray(resp.data?.organic_results) ? resp.data.organic_results : [];
  const results = organic
    .map((r) => ({
      title: clean(r.title),
      url: clean(r.link),
      snippet: clean(r.snippet),
    }))
    .filter((r) => r.title && r.url);

  return {
    provider: "serpapi",
    query,
    retrieved_at: new Date().toISOString(),
    results,
  };
}
