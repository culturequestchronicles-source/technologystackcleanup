// FILE: lib/websearch/index.ts
import type { WebSearchResponse } from "./types";
import { serpApiSearch } from "./serpapi";
import { bingSearch } from "./bing";

export async function webSearch(query: string, maxResults = 5): Promise<WebSearchResponse | null> {
  const provider = (process.env.WEBSEARCH_PROVIDER || "serpapi").toLowerCase();

  if (provider === "bing") {
    return await bingSearch(query, maxResults);
  }
  // default: serpapi
  return await serpApiSearch(query, maxResults);
}
