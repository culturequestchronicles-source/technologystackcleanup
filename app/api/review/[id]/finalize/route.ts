// FILE: app/api/review/[id]/finalize/route.ts
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { buildCsvOrdered, withUtf8Bom } from "@/utils/csv-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeJsonString(v: any) {
  if (!v) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: "Use POST to generate FINAL CSV." },
    { status: 405 }
  );
}

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const uploadId = params.id;

  const { data: rows, error } = await supabase
    .from("review_rows")
    .select("*")
    .eq("upload_id", uploadId)
    .order("row_index", { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ ok: false, error: "No review rows found" }, { status: 404 });

  const enriched = rows.map((r: any) => ({
    canonical_name: r.canonical_name || "",
    canonical_vendor: r.canonical_vendor || "",
    normalized_version: r.normalized_version || "",

    major_version: r.major_version || "",
    minor_version: r.minor_version || "",
    patch_version: r.patch_version || "",
    build_version: r.build_version || "",
    service_pack: r.service_pack || "",

    input_eos: r.input_eos || "",
    input_eol: r.input_eol || "",
    corrected_eos: r.corrected_eos || "",
    corrected_eol: r.corrected_eol || "",
    lifecycle_source: r.lifecycle_source || "",
    lifecycle_notes: r.lifecycle_notes || "",

    lifecycle_evidence_url: r.lifecycle_evidence_url || "",
    lifecycle_evidence_title: r.lifecycle_evidence_title || "",
    lifecycle_retrieved_at: r.lifecycle_retrieved_at || "",

    normalized_end_of_support: r.normalized_end_of_support || "",
    normalized_end_of_life: r.normalized_end_of_life || "",

    vuln_total: r.vuln_total ?? "",
    vuln_top: r.vuln_top || "",
    vuln_sources: r.vuln_sources || "",
    kev_flagged: r.kev_flagged ? "TRUE" : "FALSE",

    enrichment_json: safeJsonString(r.enrichment_json),

    domain: r.domain || "",
    confidence: (r.confidence ?? 0).toString(),
    vendor_site_verified: r.vendor_site_verified ? "TRUE" : "FALSE",
    vendor_site_url: r.vendor_site_url || "",
    review_required: r.review_required ? "TRUE" : "FALSE",
    validation_notes: r.validation_notes || "",
    ai_notes: r.ai_notes || "",

    ...(r.cleaned || {}),
  }));

  const { data: raw, error: rawErr } = await supabase
    .from("raw_rows")
    .select("raw_data")
    .eq("upload_id", uploadId)
    .order("row_index", { ascending: true })
    .limit(1)
    .single();

  const originalHeaders = rawErr ? [] : Object.keys(raw?.raw_data || {});

  const extraHeadersPreferredOrder = [
    "canonical_name",
    "canonical_vendor",
    "normalized_version",
    "major_version",
    "minor_version",
    "patch_version",
    "build_version",
    "service_pack",

    "input_eos",
    "input_eol",
    "corrected_eos",
    "corrected_eol",
    "lifecycle_source",
    "lifecycle_notes",

    "lifecycle_evidence_url",
    "lifecycle_evidence_title",
    "lifecycle_retrieved_at",

    "vuln_total",
    "vuln_top",
    "vuln_sources",
    "kev_flagged",

    "enrichment_json",

    "normalized_end_of_support",
    "normalized_end_of_life",
    "domain",
    "confidence",
    "vendor_site_verified",
    "vendor_site_url",
    "review_required",
    "validation_notes",
    "ai_notes",
  ];

  const csv = buildCsvOrdered(enriched, originalHeaders, extraHeadersPreferredOrder);
  const csvWithBom = withUtf8Bom(csv);

  const path = `outputs/${uploadId}/FINAL_${Date.now()}.csv`;

  const { error: uploadErr } = await supabase.storage
    .from("uploads")
    .upload(path, Buffer.from(csvWithBom, "utf-8"), {
      contentType: "text/csv; charset=utf-8",
      upsert: true,
    });

  if (uploadErr) return NextResponse.json({ ok: false, error: uploadErr.message }, { status: 500 });

  const { error: insertErr } = await supabase.from("outputs").insert({
    upload_id: uploadId,
    storage_path: path,
  });

  if (insertErr) return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });

  // Optional: repair job status (nice UX)
  try {
    await supabase.from("jobs").update({ status: "completed", progress: 100, error: null }).eq("upload_id", uploadId);
    await supabase.from("uploads").update({ status: "completed" }).eq("id", uploadId);
  } catch {}

  return NextResponse.json({ ok: true, uploadId, storage_path: path, source: "review_rows" });
}
