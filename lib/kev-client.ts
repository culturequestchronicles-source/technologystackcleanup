// FILE: lib/kev-client.ts
import { getJsonSafe } from "@/lib/http";

let _kevSet: Set<string> | null = null;
let _kevLoadedAt: number | null = null;

// Refresh KEV cache every 24 hours (safe + prevents stale forever)
const KEV_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureKevLoaded() {
  const now = Date.now();
  if (_kevSet && _kevLoadedAt && now - _kevLoadedAt < KEV_TTL_MS) return;

  const url = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
  const json = await getJsonSafe<any>(url, { timeoutMs: 20000 });

  const vulns = json.ok && Array.isArray(json.data?.vulnerabilities) ? json.data.vulnerabilities : [];

  const s = new Set<string>();
  for (const v of vulns) {
    const cveID = String(v?.cveID || v?.cveId || "").trim().toUpperCase();
    if (cveID.startsWith("CVE-")) s.add(cveID);
  }

  _kevSet = s;
  _kevLoadedAt = now;
}

export function isKevCve(cveId: string): boolean {
  const id = (cveId ?? "").toString().trim().toUpperCase();
  if (!id.startsWith("CVE-")) return false;
  if (!_kevSet) return false; // not loaded yet
  return _kevSet.has(id);
}

// Call once during pipeline start (recommended)
export async function primeKevCache() {
  await ensureKevLoaded();
}
