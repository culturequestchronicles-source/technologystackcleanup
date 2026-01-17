// FILE: lib/endoflife-date.ts
import { getJsonSafe } from "@/lib/http";

type ProductIndexItem = { product: string; title?: string };
type CycleItem = {
  cycle?: string;
  releaseDate?: string;
  eol?: string;
  support?: string;
  latest?: string;
  link?: string;
};

let _allProductsCache: ProductIndexItem[] | null = null;
let _productCyclesCache: Record<string, CycleItem[]> = {};

function clean(v: any) {
  return (v ?? "").toString().trim();
}

function normText(v: string) {
  return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Key aliases where the endoflife.date product slug differs from common naming
 */
const ALIASES: Record<string, string> = {
  "sql server": "mssqlserver",
  "microsoft sql server": "mssqlserver",
  mssql: "mssqlserver",

  "windows server": "windowsserver",
  "microsoft windows server": "windowsserver",

  ngix: "nginx",
  nginx: "nginx",

  ".net": "dotnet",
  dotnet: "dotnet",
  ".net core": "dotnet",
  "microsoft .net": "dotnet",

  python: "python",
};

/**
 * Some products have cycles that don't map directly to "year".
 * Example: SQL Server 2014 == 12.0.
 */
const PRODUCT_VERSION_TO_CYCLE_MAP: Record<string, Record<string, string>> = {
  // endoflife.date slug: mssqlserver
  mssqlserver: {
    "2014": "12.0",
    "2016": "13.0",
    "2017": "14.0",
    "2019": "15.0",
    "2022": "16.0",
  },
};

async function getAllProducts(): Promise<ProductIndexItem[]> {
  if (_allProductsCache) return _allProductsCache;

  const r = await getJsonSafe<ProductIndexItem[]>("https://endoflife.date/api/all.json", {
    timeoutMs: 12000,
  });

  _allProductsCache = r.ok && Array.isArray(r.data) ? r.data : [];
  return _allProductsCache;
}

async function getProductCycles(productSlug: string): Promise<CycleItem[] | null> {
  const slug = clean(productSlug);
  if (!slug) return null;

  if (_productCyclesCache[slug]) return _productCyclesCache[slug];

  const r = await getJsonSafe<CycleItem[]>(
    `https://endoflife.date/api/${encodeURIComponent(slug)}.json`,
    { timeoutMs: 12000 }
  );

  if (!r.ok || !Array.isArray(r.data)) return null;

  _productCyclesCache[slug] = r.data;
  return r.data;
}

/**
 * Extract cycle key from a "version" string.
 * Examples:
 *  - "2014 SP3" -> key="2014"
 *  - "1.18.0" -> key="1.18"
 *  - "5.2.9" -> key="5.2"
 */
function extractCycleKeyFromVersion(version: string): { key: string; kind: "year" | "semver" | "major" | "none" } {
  const v = clean(version);
  if (!v) return { key: "", kind: "none" };

  const year = v.match(/\b(19|20)\d{2}\b/);
  if (year) return { key: year[0], kind: "year" };

  const mm = v.match(/\b(\d+)\.(\d+)\b/);
  if (mm) return { key: `${mm[1]}.${mm[2]}`, kind: "semver" };

  const maj = v.match(/\b(\d+)\b/);
  if (maj) return { key: maj[1], kind: "major" };

  return { key: "", kind: "none" };
}

function normalizeCycle(cycle: string): string {
  const c = clean(cycle);
  if (!c) return "";

  const year = c.match(/\b(19|20)\d{2}\b/);
  if (year) return year[0];

  const mm = c.match(/\b(\d+)\.(\d+)\b/);
  if (mm) return `${mm[1]}.${mm[2]}`;

  const maj = c.match(/\b(\d+)\b/);
  if (maj) return maj[1];

  return c.toLowerCase();
}

async function resolveSlugFromName(name: string): Promise<{ slug: string; notes: string } | null> {
  const raw = clean(name);
  if (!raw) return null;

  const aliasKey = normText(raw);
  if (ALIASES[aliasKey]) {
    return { slug: ALIASES[aliasKey], notes: `Alias match "${raw}" -> ${ALIASES[aliasKey]}` };
  }

  const all = await getAllProducts();
  const n = normText(raw);

  const exact = all.find((p) => normText(p.product) === n || (p.title && normText(p.title) === n));
  if (exact) return { slug: exact.product, notes: `Exact match in all.json -> ${exact.product}` };

  const contains = all.find((p) => {
    const t = normText(p.title || "");
    const s = normText(p.product || "");
    return t.includes(n) || n.includes(t) || s.includes(n) || n.includes(s);
  });

  if (contains) return { slug: contains.product, notes: `Fuzzy match in all.json -> ${contains.product}` };

  return null;
}

function pickBestCycle(cycles: CycleItem[], wantedKey: string): CycleItem | null {
  if (!cycles?.length || !wantedKey) return null;

  const normalizedWanted = wantedKey.trim();

  // exact cycle match
  const exact = cycles.find((c) => normalizeCycle(c.cycle || "") === normalizeCycle(normalizedWanted));
  if (exact) return exact;

  // semver key "1.18" try matching cycle that starts with "1.18"
  if (normalizedWanted.includes(".")) {
    const semi = cycles.find((c) => normalizeCycle(c.cycle || "").startsWith(normalizeCycle(normalizedWanted)));
    if (semi) return semi;

    const major = normalizedWanted.split(".")[0];
    const majMatch = cycles.find((c) => normalizeCycle(c.cycle || "") === normalizeCycle(major));
    if (majMatch) return majMatch;
  }

  return null;
}

export async function resolveEndOfLifeDates(input: {
  canonical_name: string;
  canonical_vendor?: string;
  normalized_version: string;
  service_pack?: string;
}): Promise<{ source: string; support: string; eol: string; notes: string; slug?: string; cycleMatched?: string } | null> {
  const canonicalName = clean(input.canonical_name);
  if (!canonicalName) return null;

  const slugRes = await resolveSlugFromName(canonicalName);
  if (!slugRes?.slug) return null;

  const cycles = await getProductCycles(slugRes.slug);
  if (!cycles?.length) {
    return {
      source: "endoflife.date",
      support: "",
      eol: "",
      notes: `${slugRes.notes}. No cycles found for slug=${slugRes.slug}.`,
      slug: slugRes.slug,
    };
  }

  const cycleKey = extractCycleKeyFromVersion(input.normalized_version);
  if (!cycleKey.key) {
    return {
      source: "endoflife.date",
      support: "",
      eol: "",
      notes: `${slugRes.notes}. No cycle key inferred from version "${clean(input.normalized_version)}".`,
      slug: slugRes.slug,
    };
  }

  // 🔥 Special mapping for cases like SQL Server 2014 -> 12.0
  let wantedCycle = cycleKey.key;
  const map = PRODUCT_VERSION_TO_CYCLE_MAP[slugRes.slug];
  if (map && map[wantedCycle]) {
    wantedCycle = map[wantedCycle];
  }

  // Try (1) cycle match directly
  let match = pickBestCycle(cycles, wantedCycle);

  // Try (2) add service pack if provided (ex: 12.0-sp3)
  const sp = clean(input.service_pack).toLowerCase();
  if (!match && sp && wantedCycle) {
    const spCycle = `${wantedCycle}-${sp}`;
    match = pickBestCycle(cycles, spCycle);
  }

  if (match) {
    return {
      source: "endoflife.date",
      support: clean(match.support),
      eol: clean(match.eol),
      notes: `${slugRes.notes}. Matched cycle="${match.cycle}" from key="${cycleKey.key}" -> wanted="${wantedCycle}".`,
      slug: slugRes.slug,
      cycleMatched: clean(match.cycle),
    };
  }

  return {
    source: "endoflife.date",
    support: "",
    eol: "",
    notes: `${slugRes.notes}. No cycle match for key="${cycleKey.key}" -> wanted="${wantedCycle}" (kind=${cycleKey.kind}).`,
    slug: slugRes.slug,
  };
}
