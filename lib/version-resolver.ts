// FILE: lib/version-resolver.ts

type ResolveResult = {
    resolved_version: string | null;
    notes: string;
  };
  
  function isWildcard(v: string) {
    const s = (v || "").trim().toLowerCase();
    return s.includes(".x") || s.includes(".*") || s === "x" || s.includes("latest");
  }
  
  function isPrerelease(v: string) {
    const s = (v || "").toLowerCase();
    return (
      s.includes("-rc") ||
      s.includes("preview") ||
      s.includes("alpha") ||
      s.includes("beta") ||
      s.includes("nightly")
    );
  }
  
  function stableOnly(versions: string[]) {
    return versions.filter((v) => v && !isPrerelease(v));
  }
  
  function parseMajorMinor(input: string): { major: number | null; minor: number | null } {
    const m = (input || "").match(/(\d+)(?:\.(\d+))?/);
    if (!m) return { major: null, minor: null };
    return { major: Number(m[1]), minor: m[2] ? Number(m[2]) : null };
  }
  
  function compareSemverLike(a: string, b: string) {
    // Very lightweight compare: split numeric runs and compare
    const ax = (a.match(/\d+/g) || []).map(Number);
    const bx = (b.match(/\d+/g) || []).map(Number);
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
      const av = ax[i] ?? 0;
      const bv = bx[i] ?? 0;
      if (av !== bv) return bv - av; // desc
    }
    return 0;
  }
  
  async function fetchNugetVersions(packageId: string): Promise<string[]> {
    const id = packageId.toLowerCase();
    const url = `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/index.json`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`NuGet index fetch failed (${res.status})`);
    const json = await res.json();
    const versions = Array.isArray(json?.versions) ? json.versions.map(String) : [];
    return versions;
  }
  
  /**
   * Map canonical product names to NuGet packages for version resolution + OSV.
   * Expand anytime.
   */
  const NUGET_VERSION_MAP: Array<{
    match: RegExp;
    packageId: string;
    ecosystem: "NuGet";
  }> = [
    { match: /\basp\.net\s*mvc\b/i, packageId: "Microsoft.AspNet.Mvc", ecosystem: "NuGet" },
    { match: /\b\.net\s*core\b/i, packageId: "Microsoft.NETCore.App", ecosystem: "NuGet" },
  ];
  
  export async function resolveWildcardVersion(opts: {
    canonical_name: string;
    normalized_version: string;
  }): Promise<ResolveResult> {
    const name = (opts.canonical_name || "").trim();
    const version = (opts.normalized_version || "").trim();
  
    if (!version) return { resolved_version: null, notes: "No version provided; nothing to resolve." };
    if (!isWildcard(version)) return { resolved_version: version, notes: "Version is not wildcard; kept as-is." };
  
    const mapping = NUGET_VERSION_MAP.find((m) => m.match.test(name));
    if (!mapping) {
      return {
        resolved_version: version,
        notes: "Wildcard detected, but no resolver mapping exists for this product; kept as-is.",
      };
    }
  
    const all = await fetchNugetVersions(mapping.packageId);
    const stable = stableOnly(all);
  
    const { major, minor } = parseMajorMinor(version);
    if (major === null) {
      return { resolved_version: version, notes: "Could not parse major version; kept wildcard." };
    }
  
    // Keep within major/minor when minor exists, else within major
    const filtered = stable.filter((v) => {
      const mm = parseMajorMinor(v);
      if (mm.major !== major) return false;
      if (minor !== null && mm.minor !== minor) return false;
      return true;
    });
  
    if (!filtered.length) {
      return {
        resolved_version: version,
        notes: `No stable versions found for ${mapping.packageId} matching ${major}.${minor ?? "x"}.*; kept wildcard.`,
      };
    }
  
    filtered.sort(compareSemverLike);
    const picked = filtered[0];
  
    return {
      resolved_version: picked,
      notes: `Resolved wildcard ${version} using NuGet(${mapping.packageId}) → ${picked} (stable only).`,
    };
  }
  
  /**
   * Also used by OSV enrichment to pick ecosystem+package when applicable.
   */
  export function guessOsvPackage(opts: {
    canonical_name: string;
  }): { ecosystem: "NuGet"; name: string } | null {
    const name = (opts.canonical_name || "").trim();
    const mapping = NUGET_VERSION_MAP.find((m) => m.match.test(name));
    if (!mapping) return null;
    return { ecosystem: "NuGet", name: mapping.packageId };
  }
  