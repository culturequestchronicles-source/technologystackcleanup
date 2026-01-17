// FILE: app/api/jobs/[id]/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tryParseDebug(debug: any) {
  if (!debug) return null;
  if (typeof debug === "object") return debug;
  if (typeof debug === "string") {
    try {
      return JSON.parse(debug);
    } catch {
      return { raw: debug };
    }
  }
  return { raw: String(debug) };
}

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

function minutesBetween(a: string | null | undefined, bIso: string) {
  if (!a) return null;
  const t1 = new Date(a).getTime();
  const t2 = new Date(bIso).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
  return Math.floor((t2 - t1) / 60000);
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const uploadId = params.id;
  const headers = noStoreHeaders();

  if (!isUuidLike(uploadId)) {
    return NextResponse.json({ ok: false, error: "Invalid upload id format" }, { status: 400, headers });
  }

  const nowIso = new Date().toISOString();

  // 1) Fetch job
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("upload_id,status,progress,error,debug,created_at")
    .eq("upload_id", uploadId)
    .maybeSingle();

  if (jobErr || !job) {
    return NextResponse.json({ ok: false, error: jobErr?.message || "Job not found" }, { status: 404, headers });
  }

  const parsedDebug = tryParseDebug(job.debug);

  // 2) Latest CSV output
  const { data: outs, error: outErr } = await supabase
    .from("outputs")
    .select("storage_path, created_at")
    .eq("upload_id", uploadId)
    .order("created_at", { ascending: false })
    .limit(25);

  const latestCsv = (outs || []).find((r) => (r.storage_path || "").toLowerCase().endsWith(".csv"));
  const hasCsvOutput = !!latestCsv?.storage_path;

  // 3) Review rows ready?
  const { count: reviewCount, error: reviewErr } = await supabase
    .from("review_rows")
    .select("id", { count: "exact", head: true })
    .eq("upload_id", uploadId);

  const reviewReady = !reviewErr && (reviewCount || 0) > 0;

  // 4) Upload status
  const { data: upRow, error: upErr } = await supabase
    .from("uploads")
    .select("status")
    .eq("id", uploadId)
    .maybeSingle();

  const uploadStatus = upRow?.status || null;

  // 5) Stale watchdog ONLY when nothing is being produced
  const createdMinutesAgo = minutesBetween(job.created_at, nowIso);
  const aiStartedAt = parsedDebug?.ai_started_at || null;
  const aiMinutesAgo = minutesBetween(aiStartedAt, nowIso);

  const nothingReady = !hasCsvOutput && !reviewReady;

  const staleAi =
    job.status === "running" &&
    nothingReady &&
    (aiMinutesAgo !== null ? aiMinutesAgo >= 10 : createdMinutesAgo !== null && createdMinutesAgo >= 12);

  // 6) Derived status rules (IMPORTANT FIX)
  // "completed" means: CSV exists OR job explicitly marked completed.
  // If review rows exist but no CSV, keep status as running (or queued) so UI doesn't lie.
  const derivedStatus =
    job.status === "failed"
      ? "failed"
      : hasCsvOutput || job.status === "completed"
      ? "completed"
      : staleAi
      ? "failed"
      : job.status;

  const derivedProgress =
    derivedStatus === "completed" ? (hasCsvOutput ? 100 : Math.max(job.progress || 0, 90)) : job.progress || 0;

  const csvMissingButReviewReady = reviewReady && !hasCsvOutput;

  return NextResponse.json(
    {
      ok: true,
      job: {
        upload_id: job.upload_id,
        status: derivedStatus,
        progress: derivedProgress,
        error: job.error,
        debug: parsedDebug,
        created_at: job.created_at,

        outputPath: latestCsv?.storage_path || null,
        outputExists: hasCsvOutput,
        csvReady: hasCsvOutput,

        reviewReady,
        reviewCount: reviewCount || 0,

        // ✅ new - lets UI show the correct banner
        csvMissingButReviewReady,
      },
      meta: {
        serverTime: nowIso,
        outputsQueryError: outErr?.message || null,
        uploadsQueryError: upErr?.message || null,
        uploadStatus,
        hasCsvOutput,
        latestCsvPath: latestCsv?.storage_path || null,
        reviewQueryError: reviewErr?.message || null,
        reviewReady,
        reviewCount: reviewCount || 0,
        createdMinutesAgo,
        aiMinutesAgo,
        staleAi,
      },
    },
    { headers }
  );
}
