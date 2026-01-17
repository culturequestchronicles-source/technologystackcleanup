// FILE: lib/vendor-lifecycle/microsoft.ts
import { getJsonSafe, fetchWithTimeout } from "@/lib/http";

function clean(v: any) {
  return (v ?? "").toString().trim();
}

function toIsoDateOnly(msLifecycleTs: string): string {
  // Input looks like: 2024-07-09T22:59:59.999-08:00
  const s = clean(msLifecycleTs);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

async function fetchHtml(url: string, timeoutMs = 12000): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, { timeoutMs, method: "GET" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Very lightweight HTML table extraction for the Microsoft Lifecycle pages.
 * We only need specific rows that appear as plain text in the HTML.
 */
function extractFirstMatch(html: string, re: RegExp): string {
  const m = html.match(re);
  return m ? clean(m[1]) : "";
}

export type MicrosoftLifecycleResult = {
  source: "microsoft_lifecycle";
  source_url: string;

  mainstream_end: string; // YYYY-MM-DD
  extended_end: string;   // YYYY-MM-DD

  // Optional add-ons
  service_pack_end?: string; // YYYY-MM-DD
  esu_year3_end?: string;    // YYYY-MM-DD

  notes: string;
};

/**
 * Currently implemented for SQL Server yyyy (ex: SQL Server 2014).
 * Expand later for Windows Server, .NET, etc.
 */
export async function resolveMicrosoftLifecycle(input: {
  canonical_name: string;
  normalized_version: string; // may contain year/SP
}): Promise<MicrosoftLifecycleResult | null> {
  const name = clean(input.canonical_name).toLowerCase();
  const version = clean(input.normalized_version).toLowerCase();

  // Only handle SQL Server YYYY for now
  if (!name.includes("sql server")) return null;

  const yearMatch = (name + " " + version).match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : "";
  if (!year) return null;

  // Microsoft Lifecycle product pages follow this pattern:
  // https://learn.microsoft.com/en-us/lifecycle/products/sql-server-2014
  // (locale may vary but content is the same)
  const url = `https://learn.microsoft.com/en-us/lifecycle/products/sql-server-${year}`;

  const html = await fetchHtml(url, 12000);
  if (!html) return null;

  // Extract support dates line:
  // "SQL Server 2014 ... 2019-07-09T... 2024-07-09T..."
  // We'll regex the two timestamps after the listing name.
  const supportLineRe = new RegExp(
    `SQL\\s*Server[^\\n]*?\\s(20\\d{2}-\\d{2}-\\d{2}T[^\\s]+)\\s(20\\d{2}-\\d{2}-\\d{2}T[^\\s]+)`,
    "i"
  );

  const supportLine = html.match(supportLineRe);
  let mainstream_end = "";
  let extended_end = "";
  if (supportLine) {
    mainstream_end = toIsoDateOnly(supportLine[1]);
    extended_end = toIsoDateOnly(supportLine[2]);
  }

  // Service Pack 3 row end date (if present)
  const sp3EndRaw = extractFirstMatch(
    html,
    /Service\s*Pack\s*3[^0-9]*(20\d{2}-\d{2}-\d{2}T[^\s<]+)/i
  );
  const service_pack_end = sp3EndRaw ? toIsoDateOnly(sp3EndRaw) : "";

  // ESU Year 3 row end date (if present)
  const esu3EndRaw = extractFirstMatch(
    html,
    /Extended\s*Security\s*Updates\s*Year\s*3[^0-9]*(20\d{2}-\d{2}-\d{2}T[^\s<]+)/i
  );
  const esu_year3_end = esu3EndRaw ? toIsoDateOnly(esu3EndRaw) : "";

  if (!mainstream_end && !extended_end && !service_pack_end && !esu_year3_end) {
    return null;
  }

  const notesParts: string[] = [];
  if (mainstream_end) notesParts.push(`Mainstream support end=${mainstream_end}`);
  if (extended_end) notesParts.push(`Extended support end=${extended_end}`);
  if (service_pack_end) notesParts.push(`Service Pack 3 end=${service_pack_end}`);
  if (esu_year3_end) notesParts.push(`ESU Year 3 end=${esu_year3_end}`);

  return {
    source: "microsoft_lifecycle",
    source_url: url,
    mainstream_end,
    extended_end,
    service_pack_end: service_pack_end || undefined,
    esu_year3_end: esu_year3_end || undefined,
    notes: notesParts.join("; "),
  };
}
