// FILE: app/api/download/[id]/route.ts
import { NextResponse } from "next/server";
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
  let source: "outputs_table" | "storage_list" | null = null;

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
    return NextResponse.json(
      {
        ok: false,
        error: "No output CSV found for this upload yet.",
        meta: wantsJson
          ? {
              uploadId,
              outputsTableError: outRes.error,
              storageListError: listErrMsg,
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
