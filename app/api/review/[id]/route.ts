// FILE: app/api/review/[id]/route.ts
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function isUuidLike(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id
  );
}

function safeJsonString(v: any) {
  if (!v) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const uploadId = params.id;
  const headers = noStoreHeaders();

  if (!isUuidLike(uploadId)) {
    return NextResponse.json(
      { ok: false, error: "Invalid upload id format" },
      { status: 400, headers }
    );
  }

  const { searchParams } = new URL(req.url);
  const onlyNeedsReview = searchParams.get("onlyNeedsReview") === "1";
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") || 200)));

  let q = supabase
    .from("review_rows")
    .select("*")
    .eq("upload_id", uploadId)
    .order("row_index", { ascending: true })
    .limit(limit);

  if (onlyNeedsReview) q = q.eq("review_required", true);

  const { data: rows, error } = await q;

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500, headers });
  }

  if (rows && rows.length) {
    const baseHeaders = Object.keys(rows[0]?.cleaned || {});
    const extraHeaders = [
      "canonical_name",
      "canonical_vendor",
      "normalized_version",
      "major_version",
      "minor_version",
      "patch_version",
      "build_version",
      "service_pack",
      "normalized_end_of_support",
      "normalized_end_of_life",

      // Phase 4:
      "input_eos",
      "input_eol",
      "corrected_eos",
      "corrected_eol",
      "lifecycle_source",
      "lifecycle_notes",
      "vuln_total",
      "vuln_top",
      "vuln_sources",
      "kev_flagged",
      "enrichment_json",

      "domain",
      "confidence",
      "vendor_site_verified",
      "vendor_site_url",
      "review_required",
      "validation_notes",
      "ai_notes",
      "is_approved",
    ];

    const headersOut = Array.from(new Set([...baseHeaders, ...extraHeaders]));

    const outRows = rows.map((r: any) => ({
      row_index: r.row_index,
      rowId: r.id,
      data: {
        ...(r.cleaned || {}),

        canonical_name: r.canonical_name || "",
        canonical_vendor: r.canonical_vendor || "",
        normalized_version: r.normalized_version || "",

        major_version: r.major_version || "",
        minor_version: r.minor_version || "",
        patch_version: r.patch_version || "",
        build_version: r.build_version || "",
        service_pack: r.service_pack || "",

        normalized_end_of_support: r.normalized_end_of_support || "",
        normalized_end_of_life: r.normalized_end_of_life || "",

        input_eos: r.input_eos || "",
        input_eol: r.input_eol || "",
        corrected_eos: r.corrected_eos || "",
        corrected_eol: r.corrected_eol || "",
        lifecycle_source: r.lifecycle_source || "",
        lifecycle_notes: r.lifecycle_notes || "",

        vuln_total: r.vuln_total ?? "",
        vuln_top: r.vuln_top || "",
        vuln_sources: r.vuln_sources || "",
        kev_flagged: r.kev_flagged ? "TRUE" : "FALSE",

        // IMPORTANT: stringify for UI readability
        enrichment_json: safeJsonString(r.enrichment_json),

        domain: r.domain || "",
        confidence: r.confidence ?? "",
        vendor_site_verified: r.vendor_site_verified ? "TRUE" : "FALSE",
        vendor_site_url: r.vendor_site_url || "",
        review_required: r.review_required ? "TRUE" : "FALSE",
        validation_notes: r.validation_notes || "",
        ai_notes: r.ai_notes || "",
        is_approved: r.is_approved ? "TRUE" : "FALSE",
      },
    }));

    return NextResponse.json(
      { ok: true, uploadId, source: "review_rows", headers: headersOut, rows: outRows },
      { headers }
    );
  }

  return NextResponse.json(
    { ok: false, error: "No review_rows available yet. Wait for processing to reach completion." },
    { status: 404, headers }
  );
}
