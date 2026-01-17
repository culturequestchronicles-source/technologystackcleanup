// FILE: lib/nvd-client.ts

function clean(v: any) {
  return (v ?? "").toString().trim();
}

const NVD_API_KEY = process.env.NVD_API_KEY || process.env.NVD_APIKEY || "";
const NVD_ENDPOINT = "https://services.nvd.nist.gov/rest/json/cves/2.0";

async function fetchJson(url: string, ms = 20000): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "TechStackCleanupBot/1.0",
        ...(NVD_API_KEY ? { apiKey: NVD_API_KEY } : {}),
      },
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractYear(version: string): string {
  const v = clean(version);
  const m = v.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function extractSemverPrefix(version: string): string {
  // "5.2.9" -> "5.2"
  const v = clean(version);
  const m = v.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : "";
}

function buildKeyword(canonicalName: string, vendor: string, version: string): string {
  const cn = clean(canonicalName);
  const v = clean(version);
  const ven = clean(vendor);

  // Broaden keywords for problematic families
  const lower = cn.toLowerCase();
  if (lower.includes("asp.net mvc") || lower.includes("aspnet mvc")) {
    const mm = extractSemverPrefix(v);
    // search less strictly, NVD often indexes as "ASP.NET MVC"
    return ["ASP.NET MVC", mm || v].filter(Boolean).join(" ");
  }

  return [cn, ven, v].filter(Boolean).join(" ");
}

function buildCpeIfKnown(canonicalName: string, version: string): string | null {
  const name = clean(canonicalName).toLowerCase();
  const v = clean(version);
  if (!v) return null;

  if (name.includes("nginx")) {
    // cpe:2.3:a:nginx:nginx:1.18.0:*:*:*:*:*:*:*
    return `cpe:2.3:a:nginx:nginx:${v}:*:*:*:*:*:*:*`;
  }

  if (name.includes("sql server") || name === "sql server") {
    // SQL Server should use YEAR as version for CPE
    const year = extractYear(v) || v;
    return `cpe:2.3:a:microsoft:sql_server:${year}:*:*:*:*:*:*:*`;
  }

  return null;
}

function parseCves(json: any): Array<{ id: string; severity: string }> {
  const vulns = Array.isArray(json?.vulnerabilities) ? json.vulnerabilities : [];
  const out: Array<{ id: string; severity: string }> = [];

  for (const item of vulns) {
    const cve = item?.cve;
    const id = clean(cve?.id);
    if (!id) continue;

    const metrics = cve?.metrics || {};
    const cvss31 = metrics?.cvssMetricV31?.[0]?.cvssData?.baseSeverity;
    const cvss30 = metrics?.cvssMetricV30?.[0]?.cvssData?.baseSeverity;
    const cvss2 = metrics?.cvssMetricV2?.[0]?.baseSeverity;

    const severity = clean(cvss31 || cvss30 || cvss2 || "");
    out.push({ id, severity });
  }

  return out;
}

async function queryNvd(url: string) {
  return await fetchJson(url);
}

export async function queryNvdVulns(input: {
  canonical_name: string;
  canonical_vendor?: string;
  version: string;
}): Promise<{ cves: Array<{ id: string; severity: string }> } | null> {
  const canonicalName = clean(input.canonical_name);
  const vendor = clean(input.canonical_vendor);
  const version = clean(input.version);

  if (!canonicalName) return null;

  // Prefer CPE if possible
  const cpe = buildCpeIfKnown(canonicalName, version);

  // 1) Try CPE query
  if (cpe) {
    const p = new URLSearchParams();
    p.set("resultsPerPage", "20");
    p.set("cpeName", cpe);

    const url = `${NVD_ENDPOINT}?${p.toString()}`;
    const json = await queryNvd(url);
    const cves = parseCves(json);

    // If CPE returned results, use them
    if (cves.length > 0) return { cves };

    // If CPE returned nothing, fall through to keywordSearch (important for nginx & others)
  }

  // 2) Keyword fallback (broader)
  const p2 = new URLSearchParams();
  p2.set("resultsPerPage", "20");
  p2.set("keywordSearch", buildKeyword(canonicalName, vendor, version));

  const url2 = `${NVD_ENDPOINT}?${p2.toString()}`;
  const json2 = await queryNvd(url2);
  const cves2 = parseCves(json2);

  return { cves: cves2 };
}
