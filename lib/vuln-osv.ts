// FILE: lib/vuln-osv.ts
import { guessOsvPackage } from "@/lib/version-resolver";

type OsvVuln = {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
};

export async function queryOsv(opts: {
  canonical_name: string;
  version: string;
}): Promise<{ cves: string[]; total: number; notes: string }> {
  const pkg = guessOsvPackage({ canonical_name: opts.canonical_name });
  if (!pkg) return { cves: [], total: 0, notes: "No OSV package mapping for this product." };

  if (!opts.version || /\bx\b/i.test(opts.version) || opts.version.includes("*")) {
    return { cves: [], total: 0, notes: "OSV skipped: version is not concrete." };
  }

  const res = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      package: { ecosystem: pkg.ecosystem, name: pkg.name },
      version: opts.version,
    }),
  });

  if (!res.ok) {
    return { cves: [], total: 0, notes: `OSV query failed (${res.status}).` };
  }

  const json = await res.json();
  const vulns: OsvVuln[] = Array.isArray(json?.vulns) ? json.vulns : [];

  const cves = new Set<string>();
  for (const v of vulns) {
    const aliases = Array.isArray(v.aliases) ? v.aliases : [];
    for (const a of aliases) {
      if (String(a).toUpperCase().startsWith("CVE-")) cves.add(String(a).toUpperCase());
    }
  }

  return {
    cves: Array.from(cves),
    total: vulns.length,
    notes: `OSV ok: ecosystem=${pkg.ecosystem} name=${pkg.name} vulns=${vulns.length}`,
  };
}
