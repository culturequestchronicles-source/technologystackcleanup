// FILE: lib/websearch/bing.ts
import { getJsonSafe } from "@/lib/http";
import type { WebSearchResponse } from "./types";

function clean(v: any) {
  return (v ?? "").toString().trim();
}

type BingWebPageItem = { name?: string; url?: string; snippet?: string };
type BingResponse = { webPages?: { value?: BingWebPageItem[] } };

export async function bingSearch(query: string, maxResults = 5): Promise<WebSearchResponse | null> {
  const key = process.env.BING_SEARCH_KEY || "";
  const endpoint = process.env.BING_SEARCH_ENDPOINT || "https://api.bing.microsoft.com/v7.0/search";
  if (!key) return null;

  const p = new URLSearchParams();
  p.set("q", query);
  p.set("count", String(Math.min(10, Math.max(1, maxResults))));
  p.set("textDecorations", "false");
  p.set("textFormat", "Raw");

  const url = `${endpoint}?${p.toString()}`;

  const resp = await getJsonSafe<BingResponse>(url, {
    timeoutMs: 20000,
    headers: { "Ocp-Apim-Subscription-Key": key, "User-Agent": "TechStackCleanupBot/1.0" },
  });

  if (!resp.ok) return null;

  const items = Array.isArray(resp.data?.webPages?.value) ? resp.data.webPages.value : [];
  const results = items
    .map((r) => ({
      title: clean(r.name),
      url: clean(r.url),
      snippet: clean(r.snippet),
    }))
    .filter((r) => r.title && r.url);

  return {
    provider: "bing",
    query,
    retrieved_at: new Date().toISOString(),
    results,
  };
}
