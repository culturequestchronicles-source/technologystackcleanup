// FILE: lib/review-rows.ts
import { supabase } from "@/lib/supabase";

function toBool(v: any) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES";
}

function toNum(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function upsertReviewRows(opts: {
  uploadId: string;
  rows: Array<Record<string, any>>;
}) {
  const { uploadId, rows } = opts;
  if (!rows.length) return;

  const payload = rows.map((r, idx) => ({
    upload_id: uploadId,
    row_index: idx + 1,

    original: r,
    cleaned: r,

    canonical_name: r.canonical_name ?? "",
    canonical_vendor: r.canonical_vendor ?? "",
    normalized_version: r.normalized_version ?? "",
    normalized_end_of_support: r.normalized_end_of_support ?? "",
    normalized_end_of_life: r.normalized_end_of_life ?? "",
    domain: r.domain ?? "",

    major_version: r.major_version ?? "",
    minor_version: r.minor_version ?? "",
    patch_version: r.patch_version ?? "",
    build_version: r.build_version ?? "",
    service_pack: r.service_pack ?? "",

    // Phase 4 lifecycle inputs + corrections
    input_eos: r.input_eos ?? "",
    input_eol: r.input_eol ?? "",
    corrected_eos: r.corrected_eos ?? "",
    corrected_eol: r.corrected_eol ?? "",
    lifecycle_source: r.lifecycle_source ?? "",
    lifecycle_notes: r.lifecycle_notes ?? "",

    // Phase 4 vulns
    vuln_total: toNum(r.vuln_total, 0),
    vuln_top: r.vuln_top ?? "",
    vuln_sources: r.vuln_sources ?? "",
    kev_flagged: toBool(r.kev_flagged),

    enrichment_json: r.enrichment_json ?? {},

    vendor_site_url: r.vendor_site_url ?? "",
    vendor_site_verified: toBool(r.vendor_site_verified),

    confidence: toNum(r.confidence, 0),
    review_required: toBool(r.review_required),
    validation_notes: r.validation_notes ?? "",
    ai_notes: r.ai_notes ?? "",
    is_approved: toBool(r.is_approved),
  }));

  // Idempotent: delete previous rows for this upload
  const del = await supabase.from("review_rows").delete().eq("upload_id", uploadId);
  if (del.error) throw new Error(del.error.message);

  const ins = await supabase.from("review_rows").insert(payload);
  if (ins.error) throw new Error(ins.error.message);
}
