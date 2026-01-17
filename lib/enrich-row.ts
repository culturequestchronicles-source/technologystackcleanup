// FILE: lib/enrich-row.ts
import { resolveEndOfLifeDates } from "@/lib/endoflife-date";
import { resolveWildcardVersionIfNeeded } from "@/lib/nuget-resolver";
import { queryOsvVulns } from "@/lib/osv-client";
import { queryNvdVulns } from "@/lib/nvd-client";
import { isKevCve } from "@/lib/kev-client";
import { stabilizeDomain } from "@/lib/domain-classifier";

import { resolveVendorLifecycle } from "@/lib/vendor-lifecycle";
import { webSearch } from "@/lib/websearch";
import { extractLifecycleFromEvidence } from "@/lib/lifecycle-ai-from-evidence";

export type EnrichmentResult = {
  input_eos: string;
  input_eol: string;
  corrected_eos: string;
  corrected_eol: string;
  lifecycle_source: string;
  lifecycle_notes: string;

  lifecycle_evidence_url?: string;
  lifecycle_evidence_title?: string;
  lifecycle_retrieved_at?: string;

  vuln_total: number;
  vuln_top: string;
  vuln_sources: string;
  kev_flagged: "TRUE" | "FALSE";
};

function cleanStr(v: any) {
  return (v ?? "").toString().trim();
}

function boolToTF(b: boolean) {
  return b ? "TRUE" : "FALSE";
}

function safeErrMessage(err: any) {
  return err?.message || err?.cause?.message || (typeof err === "string" ? err : "Unknown error");
}

function hasAnyDate(eos: string, eol: string) {
  return !!cleanStr(eos) || !!cleanStr(eol);
}

function nowIso() {
  return new Date().toISOString();
}

// Hard limits so DB rows don’t explode in size
function limitArray<T>(arr: T[], max: number) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}

// Small helper so enrichment steps can NEVER hang the pipeline
async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const p = fn();
    const timeoutPromise = new Promise<T>((_, rej) =>
      controller.signal.addEventListener("abort", () => rej(new Error(`${label} timed out after ${ms}ms`)), { once: true })
    );
    return await Promise.race([p, timeoutPromise]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Very small vendor guess fallback (safe + conservative).
 * Expand over time if you want.
 */
function guessVendorIfMissing(name: string, currentVendor: string) {
  const n = cleanStr(name).toLowerCase();
  if (currentVendor) return currentVendor;

  if (n.includes("sql server") || n.includes("windows server") || n.includes("asp.net") || n.includes(".net")) {
    return "Microsoft";
  }
  if (n.includes("nginx")) return "NGINX";
  if (n === "python") return "Python Software Foundation";

  return "";
}

export async function enrichNormalizedRow(input: {
  canonical_name: string;
  canonical_vendor: string;
  normalized_version: string;
  service_pack?: string;

  input_eos?: string;
  input_eol?: string;

  domain?: string;
  vendor_site_url?: string;
}): Promise<{ patched: Partial<any>; enrichment: EnrichmentResult }> {
  const canonical_name = cleanStr(input.canonical_name);
  let canonical_vendor = cleanStr(input.canonical_vendor);
  let normalized_version = cleanStr(input.normalized_version);
  const service_pack = cleanStr(input.service_pack);

  canonical_vendor = guessVendorIfMissing(canonical_name, canonical_vendor);

  const input_eos = cleanStr(input.input_eos);
  const input_eol = cleanStr(input.input_eol);

  const lifecycle_notes: string[] = [];
  let lifecycle_source = "";
  let corrected_eos = "";
  let corrected_eol = "";

  let lifecycle_evidence_url = "";
  let lifecycle_evidence_title = "";
  let lifecycle_retrieved_at = "";

  // This will be stored into review_rows.enrichment_json (DB), NOT required for CSV export
  const enrichment_bundle: any = {
    lifecycle: {},
    vulns: {},
    meta: {
      canonical_name,
      canonical_vendor,
      normalized_version,
      service_pack,
      created_at: nowIso(),
    },
  };

  // ---------------------------
  // (A) Version wildcard resolution
  // ---------------------------
  try {
    const versionResolution = await withTimeout("Wildcard version resolve", 12000, async () =>
      resolveWildcardVersionIfNeeded({
        canonical_name,
        canonical_vendor,
        version: normalized_version,
      })
    );

    if (versionResolution?.resolved_version && versionResolution.resolved_version !== normalized_version) {
      lifecycle_notes.push(
        `Resolved wildcard version "${normalized_version}" -> "${versionResolution.resolved_version}" (${versionResolution.source}).`
      );
      normalized_version = versionResolution.resolved_version;
      enrichment_bundle.meta.version_resolved = {
        from: input.normalized_version,
        to: normalized_version,
        source: versionResolution.source,
      };
    } else if (versionResolution?.notes) {
      lifecycle_notes.push(versionResolution.notes);
    }
  } catch (e: any) {
    lifecycle_notes.push(`Wildcard version resolver failed: ${safeErrMessage(e)}`);
  }

  // ---------------------------
  // (B) Vendor lifecycle FIRST (best source)
  // ---------------------------
  try {
    const vendorLife = await withTimeout("Vendor lifecycle lookup", 12000, async () =>
      resolveVendorLifecycle({
        canonical_name,
        canonical_vendor,
        normalized_version,
        service_pack,
      })
    );

    if (vendorLife) {
      lifecycle_source = vendorLife.source || "vendor";
      corrected_eos = cleanStr(vendorLife.support_end || "");
      corrected_eol = cleanStr(vendorLife.eol_end || "");

      lifecycle_evidence_url = cleanStr(vendorLife.source_url || "");
      lifecycle_evidence_title = `${canonical_vendor} lifecycle`;
      lifecycle_retrieved_at = nowIso();

      lifecycle_notes.push(`Vendor lifecycle used (${lifecycle_source}): ${vendorLife.notes || "matched"}`);
      if (lifecycle_evidence_url) lifecycle_notes.push(`Source URL: ${lifecycle_evidence_url}`);

      enrichment_bundle.lifecycle.vendor = {
        ...vendorLife,
        retrieved_at: lifecycle_retrieved_at,
      };
    } else {
      lifecycle_notes.push("Vendor lifecycle: no match (or vendor resolver not available).");
    }
  } catch (e: any) {
    lifecycle_notes.push(`Vendor lifecycle failed: ${safeErrMessage(e)}`);
  }

  // ---------------------------
  // (C) endoflife.date fallback
  // ---------------------------
  if (!hasAnyDate(corrected_eos, corrected_eol)) {
    try {
      const lifecycle = await withTimeout("Lifecycle lookup (endoflife.date)", 12000, async () =>
        resolveEndOfLifeDates({
          canonical_name,
          canonical_vendor,
          normalized_version,
          service_pack,
        })
      );

      if (lifecycle) {
        lifecycle_source = lifecycle.source || "endoflife.date";
        corrected_eos = cleanStr(lifecycle.support || "");
        corrected_eol = cleanStr(lifecycle.eol || "");

        // endoflife.date evidence URL is predictable
        const slug = cleanStr((lifecycle as any).slug || "");
        lifecycle_evidence_url = slug ? `https://endoflife.date/${encodeURIComponent(slug)}` : "";
        lifecycle_evidence_title = "endoflife.date";
        lifecycle_retrieved_at = nowIso();

        lifecycle_notes.push(lifecycle.notes || "endoflife.date matched.");
        if (lifecycle_evidence_url) lifecycle_notes.push(`Evidence URL: ${lifecycle_evidence_url}`);

        enrichment_bundle.lifecycle.endoflife = {
          ...lifecycle,
          evidence_url: lifecycle_evidence_url,
          retrieved_at: lifecycle_retrieved_at,
        };
      } else {
        lifecycle_notes.push("No lifecycle match found (endoflife.date).");
      }
    } catch (e: any) {
      lifecycle_notes.push(`Lifecycle enrichment failed (endoflife.date): ${safeErrMessage(e)}`);
    }
  }

  // ---------------------------
  // (D) Web evidence fallback + AI extraction (last resort)
  // ---------------------------
  if (!hasAnyDate(corrected_eos, corrected_eol)) {
    try {
      // NOTE: webSearch should internally return null/empty if no API key configured.
      const query = `${canonical_vendor} ${canonical_name} ${normalized_version} end of support end of life lifecycle`;
      const evidence = await withTimeout("Web search", 20000, async () => webSearch(query, 5));

      const results = evidence?.results || [];
      if (Array.isArray(results) && results.length > 0) {
        // Keep only top N results to avoid huge DB rows
        const trimmedEvidence = {
          provider: evidence.provider,
          query: evidence.query,
          results: limitArray(results, 5),
        };

        enrichment_bundle.lifecycle.websearch = {
          ...trimmedEvidence,
          retrieved_at: nowIso(),
        };

        const extracted = await withTimeout("AI lifecycle from evidence", 20000, async () =>
          extractLifecycleFromEvidence({
            canonical_vendor,
            canonical_name,
            normalized_version,
            evidence: trimmedEvidence,
          })
        );

        if (extracted) {
          corrected_eos = cleanStr(extracted.support_end || "");
          corrected_eol = cleanStr(extracted.eol_end || "");

          lifecycle_source = cleanStr(extracted.source || "web_evidence_ai");
          lifecycle_evidence_url = cleanStr(extracted.evidence_url || "");
          lifecycle_evidence_title = cleanStr(extracted.evidence_title || "");
          lifecycle_retrieved_at = cleanStr(extracted.retrieved_at || nowIso());

          lifecycle_notes.push(`Web evidence used: ${extracted.notes || "AI extracted dates"}`);
          if (lifecycle_evidence_url) lifecycle_notes.push(`Evidence URL: ${lifecycle_evidence_url}`);

          enrichment_bundle.lifecycle.web_ai = {
            ...extracted,
            retrieved_at: lifecycle_retrieved_at,
          };
        } else {
          lifecycle_notes.push("Web evidence found, but AI could not extract dates safely (no explicit dates).");
        }
      } else {
        lifecycle_notes.push("Web search: no results (or missing API key).");
      }
    } catch (e: any) {
      lifecycle_notes.push(`Web evidence fallback failed: ${safeErrMessage(e)}`);
    }
  }

  // ---------------------------
  // Final safe fallback: use input values (never lose user-provided dates)
  // ---------------------------
  if (!corrected_eos) corrected_eos = input_eos || "";
  if (!corrected_eol) corrected_eol = input_eol || "";

  // Make source explicit if we only used input
  if (!lifecycle_source) {
    lifecycle_source = hasAnyDate(corrected_eos, corrected_eol) ? "input" : "none";
  }

  // If we have dates but never set evidence, keep notes clean
  if (hasAnyDate(corrected_eos, corrected_eol) && !lifecycle_retrieved_at) {
    lifecycle_retrieved_at = nowIso();
  }

  // ---------------------------
  // (E) Vulnerabilities: OSV + NVD
  // ---------------------------
  let vuln_total = 0;
  const sources: string[] = [];
  const cves: Array<{ id: string; severity: string }> = [];

  try {
    const osv = await withTimeout("OSV query", 12000, async () =>
      queryOsvVulns({
        canonical_name,
        canonical_vendor,
        version: normalized_version,
      })
    );

    if (osv && Array.isArray(osv.cves) && osv.cves.length) {
      sources.push("OSV");
      vuln_total += osv.cves.length;
      cves.push(...osv.cves);

      enrichment_bundle.vulns.osv = {
        total: osv.cves.length,
        cves: limitArray(osv.cves, 25),
      };
    }
  } catch (e: any) {
    lifecycle_notes.push(`OSV query failed: ${safeErrMessage(e)}`);
  }

  try {
    const nvd = await withTimeout("NVD query", 15000, async () =>
      queryNvdVulns({
        canonical_name,
        canonical_vendor,
        version: normalized_version,
      })
    );

    if (nvd && Array.isArray(nvd.cves) && nvd.cves.length) {
      sources.push("NVD");

      const existing = new Set(cves.map((x) => x.id));
      for (const c of nvd.cves) {
        if (!existing.has(c.id)) {
          cves.push(c);
          existing.add(c.id);
          vuln_total += 1;
        }
      }

      enrichment_bundle.vulns.nvd = {
        total: nvd.cves.length,
        cves: limitArray(nvd.cves, 25),
      };
    }
  } catch (e: any) {
    lifecycle_notes.push(`NVD query failed: ${safeErrMessage(e)}`);
  }

  const kevHit = cves.some((c) => isKevCve(c.id));

  const top = cves
    .slice(0, 5)
    .map((c) => (c.severity ? `${c.id}(${c.severity})` : c.id))
    .join("; ");

  enrichment_bundle.vulns.summary = {
    vuln_total,
    sources: sources.join(";"),
    kev_flagged: boolToTF(kevHit),
    top: top || "",
  };

  const enrichment: EnrichmentResult = {
    input_eos,
    input_eol,
    corrected_eos,
    corrected_eol,
    lifecycle_source,
    lifecycle_notes: lifecycle_notes.join(" ").trim(),

    lifecycle_evidence_url: lifecycle_evidence_url || undefined,
    lifecycle_evidence_title: lifecycle_evidence_title || undefined,
    lifecycle_retrieved_at: lifecycle_retrieved_at || undefined,

    vuln_total,
    vuln_top: top,
    vuln_sources: sources.join(";"),
    kev_flagged: boolToTF(kevHit),
  };

  // ---------------------------
  // (F) Domain stabilization (never fail pipeline)
  // ---------------------------
  let stabilizedDomain = "";
  try {
    stabilizedDomain = stabilizeDomain({
      canonical_name,
      canonical_vendor,
      current_domain: cleanStr(input.domain),
    });
  } catch {
    // ignore
  }

  const patched: Partial<any> = {
    canonical_vendor,
    normalized_version,
    domain: stabilizedDomain || input.domain || "",

    input_eos,
    input_eol,
    corrected_eos,
    corrected_eol,
    lifecycle_source,
    lifecycle_notes: enrichment.lifecycle_notes,

    lifecycle_evidence_url: lifecycle_evidence_url || "",
    lifecycle_evidence_title: lifecycle_evidence_title || "",
    lifecycle_retrieved_at: lifecycle_retrieved_at || "",

    // DB-only bundle (review_rows.enrichment_json)
    enrichment_json: enrichment_bundle,
  };

  return { patched, enrichment };
}
