// FILE: lib/vendor-lifecycle/redhat.ts
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

export async function resolveRedhatLifecycle(input: {
  canonical_name: string;
  canonical_vendor: string;
  normalized_version: string;
}): Promise<VendorLifecycleResult | null> {
  const name = norm(input.canonical_name);
  if (!name) return null;

  // Target: RHEL
  if (!name.includes("red hat") && !name.includes("rhel") && !name.includes("enterprise linux")) return null;

  // Public Red Hat pages can move; use best-effort.
  const url = "https://access.redhat.com/support/policy/updates/errata";
  const html = await fetchHtml(url);
  if (!html) return null;

  // Only accept if we can locate obvious ISO dates (rare).
  // If no clear data, return null and let endoflife.date (or review) handle it.
  return null;
}
