// FILE: app/api/download/[id]/route.ts
import { NextResponse } from "next/server";
import { buildCsvOrdered, withUtf8Bom } from "@/utils/csv-export";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function isUuidLike(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function safeTs(v: any): number {
  const t = new Date(v || "").getTime();
  return Number.isFinite(t) ? t : 0;
}

function pickLatestCsvFromStorage(list: any[] | null | undefined, uploadId: string) {
  const files = (list || [])
    .filter((x) => x?.name && String(x.name).toLowerCase().endsWith(".csv"))
    .map((x) => ({
      name: String(x.name),
      updated_at: safeTs(x.updated_at),
      created_at: safeTs(x.created_at),
    }));

  if (!files.length) return null;

  files.sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at));
  return `outputs/${uploadId}/${files[0].name}`;
}

async function findLatestCsvFromOutputsTable(uploadId: string) {
  const { data: outs, error } = await supabase
    .from("outputs")
    .select("storage_path, created_at")
    .eq("upload_id", uploadId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return { storagePath: null as string | null, error: error.message };

  const storagePath =
    (outs || []).find((r) => String(r.storage_path || "").toLowerCase().endsWith(".csv"))?.storage_path || null;

  return { storagePath, error: null as string | null };
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const uploadId = params.id;
  const url = new URL(req.url);
  const headers = noStoreHeaders();
  const wantsJson = url.searchParams.get("json") === "1";

  if (!isUuidLike(uploadId)) {
    return NextResponse.json({ ok: false, error: "Invalid upload id format" }, { status: 400, headers });
  }

  let storagePath: string | null = null;
  let source: "outputs_table" | "storage_list" | "review_rows_repair" | null = null;
  let repairError: string | null = null;

  async function tryRecoverCsvFromReviewRows() {
    const { data: rows, error } = await supabase
      .from("review_rows")
      .select("*")
      .eq("upload_id", uploadId)
      .order("row_index", { ascending: true });

    if (error) return { storagePath: null as string | null, error: error.message };
    if (!rows?.length) return { storagePath: null as string | null, error: "No review rows available" };

    const { data: raw, error: rawErr } = await supabase
      .from("raw_rows")
      .select("raw_data")
      .eq("upload_id", uploadId)
      .order("row_index", { ascending: true })
      .limit(1)
      .single();

    const originalHeaders = rawErr ? [] : Object.keys(raw?.raw_data || {});

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

      domain: r.domain || "",
      confidence: (r.confidence ?? 0).toString(),
      vendor_site_verified: r.vendor_site_verified ? "TRUE" : "FALSE",
      vendor_site_url: r.vendor_site_url || "",

      vuln_total: r.vuln_total ?? "",
      vuln_top: r.vuln_top || "",
      vuln_sources: r.vuln_sources || "",
      kev_flagged: r.kev_flagged ? "TRUE" : "FALSE",

      review_required: r.review_required ? "TRUE" : "FALSE",
      validation_notes: r.validation_notes || "",
      ai_notes: r.ai_notes || "",

      enrichment_json: r.enrichment_json || {},

      ...(r.cleaned || {}),
    }));

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

      "normalized_end_of_support",
      "normalized_end_of_life",

      "domain",
      "confidence",
      "vendor_site_verified",
      "vendor_site_url",

      "vuln_total",
      "vuln_top",
      "vuln_sources",
      "kev_flagged",

      "review_required",
      "validation_notes",
      "ai_notes",
    ];

    const csv = buildCsvOrdered(enriched, originalHeaders, extraHeadersPreferredOrder);
    const csvWithBom = withUtf8Bom(csv);

    const path = `outputs/${uploadId}/recovered_${Date.now()}.csv`;

    const { error: uploadErr } = await supabase.storage
      .from("uploads")
      .upload(path, Buffer.from(csvWithBom, "utf-8"), {
        contentType: "text/csv; charset=utf-8",
        upsert: true,
      });

    if (uploadErr) return { storagePath: null as string | null, error: uploadErr.message };

    const { error: insertErr } = await supabase.from("outputs").insert({ upload_id: uploadId, storage_path: path });
    if (insertErr) return { storagePath: null as string | null, error: insertErr.message };

    try {
      await supabase.from("jobs").update({ status: "completed", progress: 100, error: null }).eq("upload_id", uploadId);
      await supabase.from("uploads").update({ status: "completed" }).eq("id", uploadId);
    } catch {
      // best effort only
    }

    return { storagePath: path, error: null as string | null };
  }

  // 1) outputs table
  const outRes = await findLatestCsvFromOutputsTable(uploadId);
  if (outRes.storagePath) {
    storagePath = outRes.storagePath;
    source = "outputs_table";
  }

  // 2) storage list fallback
  let listErrMsg: string | null = null;
  if (!storagePath) {
    const { data: list, error: listErr } = await supabase.storage
      .from("uploads")
      .list(`outputs/${uploadId}`, { limit: 200 });

    if (listErr) {
      listErrMsg = listErr.message || String(listErr);
    } else {
      const picked = pickLatestCsvFromStorage(list, uploadId);
      if (picked) {
        storagePath = picked;
        source = "storage_list";
      }
    }
  }

  if (!storagePath) {
    const repair = await tryRecoverCsvFromReviewRows();
    if (repair.storagePath) {
      storagePath = repair.storagePath;
      source = "review_rows_repair";
    } else {
      repairError = repair.error || null;
    }
  }

  if (!storagePath) {
    return NextResponse.json(
      {
        ok: false,
        error: "No output CSV found for this upload yet.",
        meta: wantsJson
          ? {
              uploadId,
              outputsTableError: outRes.error,
              storageListError: listErrMsg,
              repairError,
            }
          : undefined,
      },
      { status: 404, headers }
    );
  }

  // Signed URL
  const { data: signed, error: signErr } = await supabase.storage
    .from("uploads")
    .createSignedUrl(storagePath, 60 * 10);

  if (signErr || !signed?.signedUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: signErr?.message || "Failed to create signed URL",
        meta: wantsJson ? { uploadId, storagePath, source } : undefined,
      },
      { status: 500, headers }
    );
  }

  if (wantsJson) {
    return NextResponse.json(
      { ok: true, uploadId, url: signed.signedUrl, storage_path: storagePath, source },
      { headers }
    );
  }

  return NextResponse.redirect(signed.signedUrl, { headers });
}
