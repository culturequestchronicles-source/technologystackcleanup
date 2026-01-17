// FILE: lib/osv-client.ts
import { postJsonSafe } from "@/lib/http";

function clean(v: any) {
  return (v ?? "").toString().trim();
}

// Map canonical tech names -> NuGet package IDs (expand as you learn more)
const NUGET_MAP: Array<{ match: RegExp; packageId: string }> = [
  { match: /asp\.?\s*net\s*mvc/i, packageId: "Microsoft.AspNet.Mvc" },
  { match: /\.net\s*core/i, packageId: "Microsoft.NETCore.App" }, // best-effort
];

function pickPackageId(canonicalName: string): string | null {
  for (const m of NUGET_MAP) {
    if (m.match.test(canonicalName)) return m.packageId;
  }
  return null;
}

type OsvResponse = {
  vulns?: Array<{
    id?: string;
    aliases?: string[];
    database_specific?: any;
    severity?: any;
  }>;
};

export async function queryOsvVulns(input: {
  canonical_name: string;
  canonical_vendor?: string;
  version: string;
}): Promise<{ cves: Array<{ id: string; severity: string }> } | null> {
  const canonicalName = clean(input.canonical_name);
  const version = clean(input.version);
  if (!canonicalName || !version) return null;

  const pkg = pickPackageId(canonicalName);
  if (!pkg) return null;

  const resp = await postJsonSafe<OsvResponse>(
    "https://api.osv.dev/v1/query",
    {
      package: { ecosystem: "NuGet", name: pkg },
      version,
    },
    { timeoutMs: 12000 }
  );

  if (!resp.ok) return { cves: [] };

  const vulns = Array.isArray(resp.data?.vulns) ? resp.data.vulns : [];
  if (!vulns.length) return { cves: [] };

  const cves: Array<{ id: string; severity: string }> = [];

  for (const v of vulns) {
    const aliases: string[] = Array.isArray(v.aliases) ? v.aliases : [];
    const cveIds = aliases.filter((x) => /^CVE-\d{4}-\d+$/i.test(x));
    for (const id of cveIds) cves.push({ id, severity: "" });
  }

  return { cves };
}
