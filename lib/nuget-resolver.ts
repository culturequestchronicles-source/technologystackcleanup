// FILE: lib/nuget-resolver.ts
/**
 * Purpose:
 * Resolve wildcard versions like "5.2.x" or "5.2.*" to a concrete stable version
 * using NuGet package indexes.
 *
 * Key properties:
 * - Hard timeout (never hangs your pipeline)
 * - Small in-memory cache
 * - Stable-only (no preview/rc/beta/alpha)
 * - Works with "v 3.9.1", "5.2.x", "5.2.*", "5.2", "5.2 wildcard"
 */

function clean(v: any) {
  return (v ?? "").toString().trim();
}

function normalizeVersionInput(v: string) {
  // "v 3.9.1" -> "3.9.1"
  return clean(v).replace(/^\s*v\s*/i, "");
}

function isWildcard(version: string) {
  const v = normalizeVersionInput(version).toLowerCase();
  return (
    v.includes(".x") ||
    v.includes(".*") ||
    v === "x" ||
    v.includes("wildcard") ||
    v.endsWith(".x") ||
    v.endsWith(".*")
  );
}

function isPreRelease(v: string) {
  return /-(preview|rc|beta|alpha|nightly)/i.test(v);
}

function getMajorMinor(version: string): string {
  const v = normalizeVersionInput(version);
  const m = v.match(/(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : "";
}

function compareSemverLikeDesc(a: string, b: string) {
  // lightweight: compare numeric runs desc
  const ax = (a.match(/\d+/g) || []).map(Number);
  const bx = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const av = ax[i] ?? 0;
    const bv = bx[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

async function fetchJsonWithTimeout(url: string, ms = 12000): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TechStackCleanupBot/1.0" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Map common tech names -> NuGet package ids
// Expand as you add more .NET/NuGet products
const NUGET_MAP: Array<{ match: RegExp; packageId: string }> = [
  { match: /\basp\.?\s*net\s*mvc\b/i, packageId: "Microsoft.AspNet.Mvc" },
  { match: /\b\.net\s*core\b/i, packageId: "Microsoft.NETCore.App" },
  { match: /\bentity\s*framework\b/i, packageId: "EntityFramework" },
];

function pickPackageId(canonicalName: string): string | null {
  const name = clean(canonicalName);
  for (const m of NUGET_MAP) {
    if (m.match.test(name)) return m.packageId;
  }
  return null;
}

// Cache NuGet index results (per run) to reduce calls + speed
const nugetIndexCache: Record<string, { versions: string[]; fetchedAt: number }> = {};
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getNugetVersions(packageId: string): Promise<string[]> {
  const id = packageId.toLowerCase();
  const cached = nugetIndexCache[id];
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.versions;

  const idx = await fetchJsonWithTimeout(
    `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/index.json`,
    12000
  );

  const versions: string[] = Array.isArray(idx?.versions)
    ? idx.versions.map((x: any) => String(x)).filter(Boolean)
    : [];

  nugetIndexCache[id] = { versions, fetchedAt: now };
  return versions;
}

export async function resolveWildcardVersionIfNeeded(input: {
  canonical_name: string;
  canonical_vendor?: string;
  version: string;
}): Promise<{ resolved_version: string | null; source: string; notes: string } | null> {
  const canonicalName = clean(input.canonical_name);
  const rawVersion = clean(input.version);

  if (!canonicalName || !rawVersion) return null;

  // Only handle wildcard versions here
  if (!isWildcard(rawVersion)) {
    return { resolved_version: null, source: "nuget", notes: "No wildcard version pattern detected." };
  }

  const packageId = pickPackageId(canonicalName);
  if (!packageId) {
    return {
      resolved_version: null,
      source: "nuget",
      notes: "Wildcard version detected but no NuGet package mapping exists.",
    };
  }

  const mm = getMajorMinor(rawVersion);
  if (!mm) {
    return { resolved_version: null, source: "nuget", notes: `Cannot infer major.minor from "${rawVersion}".` };
  }

  const versions = await getNugetVersions(packageId);
  if (!versions.length) {
    return { resolved_version: null, source: "nuget", notes: `NuGet did not return versions for "${packageId}".` };
  }

  // Filter stable versions in same major.minor, then pick latest
  const stable = versions
    .filter((v) => v && !isPreRelease(v))
    .filter((v) => v === mm || v.startsWith(mm + "."));

  if (!stable.length) {
    return {
      resolved_version: null,
      source: "nuget",
      notes: `No stable versions found matching ${mm}.x for "${packageId}".`,
    };
  }

  stable.sort(compareSemverLikeDesc);
  const resolved = stable[0];

  return {
    resolved_version: resolved,
    source: "nuget",
    notes: `Resolved via NuGet ${packageId} ${mm}.x -> ${resolved} (stable only).`,
  };
}
