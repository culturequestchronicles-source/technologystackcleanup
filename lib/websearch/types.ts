// FILE: lib/websearch/types.ts
export type WebSearchResultItem = {
    title: string;
    url: string;
    snippet: string;
  };
  
  export type WebSearchResponse = {
    provider: "serpapi" | "bing";
    query: string;
    retrieved_at: string; // ISO
    results: WebSearchResultItem[];
  };
  