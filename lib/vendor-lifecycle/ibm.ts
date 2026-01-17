// FILE: lib/vendor-lifecycle/ibm.ts
import { fetchWithTimeout } from "@/lib/http";
import type { VendorLifecycleResult } from "./types";

function clean(v: any) {
  return (v ?? "").toString().trim();
}
function norm(v: string) {
  return clean(v).toLowerCase();
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 12000, method: "GET" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function resolveIbmLifecycle(input: {
  canonical_name: string;
  canonical_vendor: string;
  normalized_version: string;
}): Promise<VendorLifecycleResult | null> {
  const name = norm(input.canonical_name);
  if (!name) return null;

  // Minimal coverage targets (expand later)
  const maybeDb2 = name.includes("db2");
  const maybeWebsphere = name.includes("websphere");

  if (!maybeDb2 && !maybeWebsphere) return null;

  // IBM lifecycle pages vary widely; we use a generic IBM support landing as a "best effort"
  // and only accept if we can find clear ISO dates near the product keywords.
  const url = "https://www.ibm.com/support/pages/";
  const html = await fetchHtml(url);
  if (!html) return null;

  // If we can't find reliable dates, do NOT fabricate.
  return null;
}
