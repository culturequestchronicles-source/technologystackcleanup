// FILE: lib/vendor-lifecycle/oracle.ts
import { fetchWithTimeout } from "@/lib/http";
import type { VendorLifecycleResult } from "./types";

function clean(v: any) {
  return (v ?? "").toString().trim();
}

function norm(v: string) {
  return clean(v).toLowerCase();
}

function extractYearOrMajor(version: string): string {
  const v = clean(version);
  if (!v) return "";
  const m = v.match(/\b(19c|21c|23c)\b/i);
  if (m) return m[1].toLowerCase();
  const y = v.match(/\b(20\d{2})\b/);
  if (y) return y[1];
  const maj = v.match(/\b(\d+)\b/);
  return maj ? maj[1] : "";
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

function isoDateOnlyFromText(s: string): string {
  const m = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

/**
 * Oracle Lifetime Support page is not structured as a simple public JSON.
 * This parser is "best effort" and will return null if it can't find reliable dates.
 */
export async function resolveOracleLifecycle(input: {
  canonical_name: string;
  canonical_vendor: string;
  normalized_version: string;
}): Promise<VendorLifecycleResult | null> {
  const name = norm(input.canonical_name);
  if (!name) return null;

  // Focus on Oracle Database only for now (safe + common)
  if (!name.includes("oracle database") && !name.includes("database")) return null;

  const verKey = extractYearOrMajor(input.normalized_version);
  if (!verKey) return null;

  const url = "https://www.oracle.com/support/lifetime-support/";
  const html = await fetchHtml(url);
  if (!html) return null;

  // Best-effort: look for the version token near "Oracle Database"
  // This can break if Oracle changes HTML; if so we return null.
  // We only accept YYYY-MM-DD dates if found.
  const window = html.slice(0, 250000); // keep it bounded
  const idx = window.toLowerCase().indexOf("oracle database");
  if (idx < 0) return null;

  const near = window.slice(Math.max(0, idx - 2000), Math.min(window.length, idx + 20000));

  // Very loose: find something like "19c" / "21c" and then ISO-like dates
  const hasVer = near.toLowerCase().includes(verKey);
  if (!hasVer) return null;

  const dates = near.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  // If we don't see at least 2 ISO dates nearby, we won't guess.
  if (dates.length < 2) return null;

  // Heuristic: earliest = support_end, later = eol_end
  const support_end = isoDateOnlyFromText(dates[0]);
  const eol_end = isoDateOnlyFromText(dates[dates.length - 1]);

  if (!support_end && !eol_end) return null;

  return {
    source: "oracle_lifetime_support",
    source_url: url,
    support_end,
    eol_end,
    notes: `Best-effort parse from Oracle Lifetime Support page for version token="${verKey}".`,
  };
}
