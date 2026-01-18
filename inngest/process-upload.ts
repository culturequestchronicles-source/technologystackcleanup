// FILE: inngest/process-upload.ts
import { inngest } from "./client";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { parseCsv } from "@/utils/file-parser";
import { detectHeaders } from "@/lib/header-detector";
import { cleanRows } from "@/lib/cleaner";
import { normalizeTechRowAI } from "@/lib/ai-normalizer";
import { buildCsvOrdered, withUtf8Bom } from "@/utils/csv-export";
import { validateVendorWebsite } from "@/lib/vendor-validate";
import { enrichNormalizedRow } from "@/lib/enrich-row";
import { primeKevCache } from "@/lib/kev-client";

type JobStatus = "queued" | "running" | "completed" | "failed";

const LIFECYCLE_STRICT_MODE = String(process.env.LIFECYCLE_STRICT_MODE || "true").toLowerCase() === "true";
const MAX_ROWS = Math.min(500, Math.max(1, Number(process.env.MAX_ROWS || "200")));
const ROW_TIMEOUT_MS = Math.min(120000, Math.max(15000, Number(process.env.ROW_TIMEOUT_MS || "45000")));

function safeErrMessage(err: any) {
  return (
    err?.message ||
    err?.response?.data?.error?.message ||
    err?.error?.message ||
    (typeof err === "string" ? err : "Unknown error")
  );
}

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

type SbResult<T> = PromiseLike<{ data: T; error: any }>;
type SbNoData = PromiseLike<{ error: any }>;

async function must<T>(label: string, p: SbResult<T>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message || String(error)}`);
  return data;
}

async function mustNoError(label: string, p: SbNoData): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${label}: ${error.message || String(error)}`);
}

async function setDebug(uploadId: string, debugObj: any) {
  await mustNoError(
    "jobs.update(debug)",
    supabase.from("jobs").update({ debug: JSON.stringify(debugObj) }).eq("upload_id", uploadId)
  );
}

async function setJob(uploadId: string, patch: Partial<{ status: JobStatus; progress: number; error: string | null }>) {
  await mustNoError("jobs.update", supabase.from("jobs").update(patch).eq("upload_id", uploadId));
}

async function setUpload(uploadId: string, patch: Partial<{ status: string }>) {
  await mustNoError("uploads.update", supabase.from("uploads").update(patch).eq("id", uploadId));
}

function cleanStr(v: any) {
  return (v ?? "").toString().trim();
}

function parseVersionParts(v: string) {
  const s = (v || "").trim();
  if (!s) return { major: "", minor: "", patch: "", build: "", service_pack: "" };

  const spMatch = s.match(/\bSP\s*([0-9]+)\b/i);
  const service_pack = spMatch ? `SP${spMatch[1]}` : "";

  const nums = s.match(/\d+/g) || [];
  const major = nums[0] ?? "";
  const minor = nums[1] ?? "";
  const patch = nums[2] ?? "";
  const build = nums.length >= 4 ? nums.slice(0, 4).join(".") : "";

  return { major, minor, patch, build, service_pack };
}

// Normalize to ISO string (DB column is timestamptz)
function toIsoTs(v: any): string | null {
  const s = cleanStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function upsertReviewRow(row: any, debug: any, warnLabel: string) {
  // Prefer upsert if your table has a unique constraint on (upload_id,row_index).
  // If not, fallback to delete+insert.
  try {
    const { error } = await supabase
      .from("review_rows")
      .upsert(row, { onConflict: "upload_id,row_index" });

    if (error) throw error;
    return;
  } catch (e: any) {
    // fallback
    try {
      await supabase.from("review_rows").delete().eq("upload_id", row.upload_id).eq("row_index", row.row_index);
      const { error } = await supabase.from("review_rows").insert(row);
      if (error) debug.warnings.push(`${warnLabel}: ${error.message || String(error)}`);
    } catch (ee: any) {
      debug.warnings.push(`${warnLabel}: ${safeErrMessage(ee)}`);
    }
  }
}

async function findLatestOutputPath(uploadId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("outputs")
      .select("storage_path, created_at")
      .eq("upload_id", uploadId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) return null;
    return data?.[0]?.storage_path || null;
  } catch {
    return null;
  }
}

export const processUpload = inngest.createFunction(
  { id: "process-upload", name: "Process Technology Upload" },
  { event: "upload/created" },
  async ({ event, step }) => {
    const uploadId = event.data.uploadId as string;

    const debug: any = {
      uploadId,
      started_at: new Date().toISOString(),
      step: "init",
      warnings: [] as string[],
    };

    async function safeSetDebug() {
      try {
        await setDebug(uploadId, debug);
      } catch {
        // ignore
      }
    }

    try {
      // If output already exists, mark completed.
      const existingOutput = await step.run("check-existing-output", async () => {
        debug.step = "check-existing-output";
        await safeSetDebug();
        return await findLatestOutputPath(uploadId);
      });

      if (existingOutput) {
        await step.run("repair-job-complete-if-needed", async () => {
          debug.step = "repair-job-complete-if-needed";
          debug.repaired_output_path = existingOutput;
          await safeSetDebug();
          await setJob(uploadId, { status: "completed", progress: 100, error: null });
          await setUpload(uploadId, { status: "completed" });
        });
        return { ok: true, uploadId, outputPath: existingOutput, repaired: true };
      }

      await step.run("job-running", async () => {
        debug.step = "job-running";
        await setJob(uploadId, { status: "running", progress: 10, error: null });
        await setUpload(uploadId, { status: "processing" });
        await safeSetDebug();
      });

      await step.run("reset-review-rows", async () => {
        debug.step = "reset-review-rows";
        await safeSetDebug();
        try {
          await supabase.from("review_rows").delete().eq("upload_id", uploadId);
          await supabase.from("raw_rows").delete().eq("upload_id", uploadId);
        } catch (e: any) {
          debug.warnings.push(`reset failed: ${safeErrMessage(e)}`);
        }
      });

      await step.run("prime-kev-cache", async () => {
        debug.step = "prime-kev-cache";
        await safeSetDebug();
        try {
          await primeKevCache();
        } catch (e: any) {
          debug.warnings.push(`KEV cache prime failed: ${safeErrMessage(e)}`);
        }
      });

      const storagePath = await step.run("fetch-storage-path", async () => {
        debug.step = "fetch-storage-path";
        const row = await must(
          "uploads.select(storage_path)",
          supabase.from("uploads").select("storage_path").eq("id", uploadId).single()
        );

        if (!row?.storage_path) throw new Error("Missing storage_path in uploads table.");
        debug.storagePath = row.storage_path;
        await safeSetDebug();
        return row.storage_path as string;
      });

      const parsed = await step.run("parse-file", async () => {
        debug.step = "parse-file";

        const { data, error } = await supabase.storage.from("uploads").download(storagePath);
        if (error || !data) throw new Error(`Failed to download file from storage: ${storagePath}`);

        const arrayBuffer = await data.arrayBuffer();
        const rows = parseCsv(arrayBuffer);

        if (!rows.length) throw new Error("Parsed 0 rows. The CSV may be empty or encoded unexpectedly.");
        const headerCount = Object.keys(rows[0]?.data || {}).length;
        if (headerCount === 0) throw new Error("Parsed header row is empty. CSV encoding/format may be invalid.");

        debug.parsed_count = rows.length;
        debug.original_headers = Object.keys(rows[0]?.data || {});
        await setJob(uploadId, { progress: 30 });
        await safeSetDebug();

        return rows;
      });

      const originalHeaders = (debug.original_headers || []) as string[];

      const mapping = await step.run("detect-headers", async () => {
        debug.step = "detect-headers";
        const first = parsed[0]?.data || {};
        const headers = Object.keys(first);
        const m = detectHeaders(headers);
        debug.header_mapping = m;
        debug.detected_at = new Date().toISOString();
        await safeSetDebug();
        return m;
      });

      const cleaned = await step.run("clean-rows", async () => {
        debug.step = "clean-rows";

        // Store raw rows (best-effort)
        for (const row of parsed) {
          try {
            await supabase.from("raw_rows").insert({
              upload_id: uploadId,
              row_index: row.rowIndex,
              raw_data: row.data,
            });
          } catch (e: any) {
            debug.warnings.push(`raw_rows insert warning: ${safeErrMessage(e)}`);
          }
        }

        const out = cleanRows(parsed.map((r) => r.data), mapping);
        debug.cleaned_count = out.length;
        await setJob(uploadId, { progress: 55 });
        await safeSetDebug();
        return out;
      });

      // IMPORTANT: per-row checkpointing so Inngest can resume and we don't lose export-output.
      debug.step = "ai-normalize + enrich";
      debug.ai_started_at = new Date().toISOString();
      await safeSetDebug();

      const rowsToProcess = cleaned.slice(0, MAX_ROWS);
      const enrichedRows: Array<Record<string, any>> = [];

      if (rowsToProcess.length === 0) {
        debug.warnings.push("No rows after cleaning; nothing to process.");
        await setJob(uploadId, { progress: 85 });
        await safeSetDebug();
      } else {
        for (let i = 0; i < rowsToProcess.length; i++) {
          const row = rowsToProcess[i];
          const rowIndexForDb = (row as any).rowIndex ?? (row as any).row_index ?? i + 1;

          const one = await step.run(`row-${rowIndexForDb}`, async () => {
            debug.ai_row = i + 1;
            debug.ai_total = rowsToProcess.length;

            const base: Record<string, any> = {
              ...(row.cleaned || row || {}),

              canonical_name: row.canonical?.technology || "",
              canonical_vendor: row.canonical?.vendor || "",
              normalized_version: row.canonical?.version || "",

              normalized_end_of_support: row.canonical?.end_of_support || "",
              normalized_end_of_life: row.canonical?.end_of_life || "",

              input_eos: row.canonical?.end_of_support || "",
              input_eol: row.canonical?.end_of_life || "",
              corrected_eos: "",
              corrected_eol: "",
              lifecycle_source: "",
              lifecycle_notes: "",

              lifecycle_evidence_url: "",
              lifecycle_evidence_title: "",
              lifecycle_retrieved_at: "",

              major_version: "",
              minor_version: "",
              patch_version: "",
              build_version: "",
              service_pack: "",

              domain: "",
              confidence: "0.50",
              review_required: "TRUE",
              validation_notes: row.validation_notes || "",
              ai_notes: "",

              vendor_site_url: "",
              vendor_site_verified: "FALSE",

              vuln_total: 0,
              vuln_top: "",
              vuln_sources: "",
              kev_flagged: "FALSE",

              enrichment_json: {},
            };

            try {
              await withTimeout(`row-${rowIndexForDb}`, ROW_TIMEOUT_MS, async () => {
                // AI normalize
                try {
                  const ai = await normalizeTechRowAI(
                    {
                      technology: row.canonical?.technology,
                      vendor: row.canonical?.vendor || null,
                      version: row.canonical?.version || null,
                      end_of_support: row.canonical?.end_of_support || null,
                      end_of_life: row.canonical?.end_of_life || null,
                    },
                    {}
                  );

                  base.canonical_name = (ai.canonical_name || base.canonical_name).trim();
                  base.canonical_vendor = (ai.canonical_vendor || base.canonical_vendor || "").trim();
                  base.normalized_version = (ai.normalized_version || base.normalized_version || "").trim();

                  base.normalized_end_of_support =
                    (ai.normalized_end_of_support || base.normalized_end_of_support || "").trim();
                  base.normalized_end_of_life =
                    (ai.normalized_end_of_life || base.normalized_end_of_life || "").trim();

                  base.domain = (ai.domain || "").trim();

                  const rawConf = Number(ai.confidence ?? 0.6);
                  base.confidence = Math.min(1, Math.max(0, rawConf)).toFixed(2);
                  base.ai_notes = ai.notes || base.ai_notes || "";
                } catch (e: any) {
                  const m = safeErrMessage(e);
                  base.ai_notes = `AI failed: ${m}`;
                  base.validation_notes = `${base.validation_notes} AI failed: ${m}`.trim();
                }

                // Vendor site
                try {
                  const sig = await validateVendorWebsite({
                    vendor_input: row.canonical?.vendor,
                    vendor_canonical: base.canonical_vendor,
                    timeout_ms: 4000,
                  });

                  base.vendor_site_url = sig.vendor_site_url || "";
                  base.vendor_site_verified = sig.vendor_site_verified ? "TRUE" : "FALSE";

                  if (sig.vendor_signal_notes) {
                    base.validation_notes = `${base.validation_notes} Vendor signal: ${sig.vendor_signal_notes}`.trim();
                  }

                  const boosted = Math.min(1, Number(base.confidence) + (sig.confidence_boost || 0));
                  base.confidence = boosted.toFixed(2);
                } catch (e: any) {
                  base.validation_notes = `${base.validation_notes} Vendor site check failed: ${safeErrMessage(e)}`.trim();
                }

                // Parse service pack early
                if (base.normalized_version) {
                  const partsEarly = parseVersionParts(base.normalized_version);
                  base.service_pack = partsEarly.service_pack;
                }

                // Enrichment
                try {
                  const { patched, enrichment } = await enrichNormalizedRow({
                    canonical_name: base.canonical_name,
                    canonical_vendor: base.canonical_vendor,
                    normalized_version: base.normalized_version,
                    service_pack: base.service_pack,
                    input_eos: base.input_eos,
                    input_eol: base.input_eol,
                    domain: base.domain,
                    vendor_site_url: base.vendor_site_url,
                  });

                  Object.assign(base, patched);

                  base.vuln_total = enrichment.vuln_total;
                  base.vuln_top = enrichment.vuln_top;
                  base.vuln_sources = enrichment.vuln_sources;
                  base.kev_flagged = enrichment.kev_flagged;

                  base.lifecycle_evidence_url = (enrichment as any).lifecycle_evidence_url || "";
                  base.lifecycle_evidence_title = (enrichment as any).lifecycle_evidence_title || "";
                  base.lifecycle_retrieved_at = (enrichment as any).lifecycle_retrieved_at || "";
                } catch (e: any) {
                  base.lifecycle_notes = `${base.lifecycle_notes} Enrichment failed: ${safeErrMessage(e)}`.trim();
                }
              });
            } catch (e: any) {
              const m = safeErrMessage(e);
              base.validation_notes = `${base.validation_notes} Row processing timeout: ${m}`.trim();
            }

            // Version parts
            if (base.normalized_version) {
              const parts = parseVersionParts(base.normalized_version);
              base.major_version = parts.major;
              base.minor_version = parts.minor;
              base.patch_version = parts.patch;
              base.build_version = parts.build;
              base.service_pack = parts.service_pack || base.service_pack || "";
            }

            const hasLifecycle = !!cleanStr(base.corrected_eos) || !!cleanStr(base.corrected_eol);
            if (LIFECYCLE_STRICT_MODE && !hasLifecycle) {
              base.validation_notes = `${base.validation_notes} Lifecycle missing after enrichment; strict mode requires review.`.trim();
            }

            const conf = Number(base.confidence || 0);
            const needsReview = conf < 0.8 || row.review_required || (LIFECYCLE_STRICT_MODE && !hasLifecycle);
            base.review_required = needsReview ? "TRUE" : "FALSE";

            // Persist review row
            await upsertReviewRow(
              {
                upload_id: uploadId,
                row_index: rowIndexForDb,

                original: row.original || null,
                cleaned: row.cleaned || row || null,

                canonical_name: base.canonical_name || "",
                canonical_vendor: base.canonical_vendor || "",
                normalized_version: base.normalized_version || "",
                normalized_end_of_support: base.normalized_end_of_support || "",
                normalized_end_of_life: base.normalized_end_of_life || "",
                domain: base.domain || "",

                major_version: base.major_version || "",
                minor_version: base.minor_version || "",
                patch_version: base.patch_version || "",
                build_version: base.build_version || "",
                service_pack: base.service_pack || "",

                input_eos: base.input_eos || "",
                input_eol: base.input_eol || "",
                corrected_eos: base.corrected_eos || "",
                corrected_eol: base.corrected_eol || "",
                lifecycle_source: base.lifecycle_source || "",
                lifecycle_notes: base.lifecycle_notes || "",

                lifecycle_evidence_url: base.lifecycle_evidence_url || "",
                lifecycle_evidence_title: base.lifecycle_evidence_title || "",
                lifecycle_retrieved_at: toIsoTs(base.lifecycle_retrieved_at),

                vendor_site_url: base.vendor_site_url || "",
                vendor_site_verified: String(base.vendor_site_verified).toUpperCase() === "TRUE",
                confidence: Number(base.confidence || 0),
                review_required: String(base.review_required).toUpperCase() === "TRUE",

                validation_notes: base.validation_notes || "",
                ai_notes: base.ai_notes || "",

                enrichment_json: base.enrichment_json || {},

                vuln_total: Number(base.vuln_total || 0),
                vuln_top: base.vuln_top || "",
                vuln_sources: base.vuln_sources || "",
                kev_flagged: String(base.kev_flagged).toUpperCase() === "TRUE",

                is_approved: false,
                edited_fields: {},
              },
              debug,
              `review_rows.upsert row ${rowIndexForDb}`
            );

            return base;
          });

          enrichedRows.push(one);

          const pct = 55 + Math.round(((i + 1) / rowsToProcess.length) * 30);
          await setJob(uploadId, { progress: pct });
          if (i === 0 || (i + 1) % 2 === 0) await safeSetDebug();
        }

        debug.ai_processed = enrichedRows.length;
        debug.ai_finished_at = new Date().toISOString();
        await setJob(uploadId, { progress: 85 });
        await safeSetDebug();
      }

      // EXPORT OUTPUT (this is what your pipeline was missing)
      const outputPath = await step.run("export-output", async () => {
        debug.step = "export-output";
        await safeSetDebug();

        if (!enrichedRows.length) throw new Error("No enriched rows to export.");

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

        const csv = buildCsvOrdered(enrichedRows, originalHeaders, extraHeadersPreferredOrder);
        const csvWithBom = withUtf8Bom(csv);

        const path = `outputs/${uploadId}/cleaned_${Date.now()}.csv`;

        const { error: uploadErr } = await supabase.storage
          .from("uploads")
          .upload(path, Buffer.from(csvWithBom, "utf-8"), {
            contentType: "text/csv; charset=utf-8",
            upsert: true,
          });

        if (uploadErr) {
          debug.export_error = uploadErr.message || String(uploadErr);
          await safeSetDebug();
          throw new Error(`Output upload failed: ${uploadErr.message}`);
        }

        await mustNoError(
          "outputs.insert",
          supabase.from("outputs").insert({ upload_id: uploadId, storage_path: path })
        );

        debug.output_path = path;
        await setJob(uploadId, { progress: 95 });
        await safeSetDebug();

        return path;
      });

      await step.run("job-complete", async () => {
        debug.step = "job-complete";
        debug.finished_at = new Date().toISOString();
        await safeSetDebug();

        await setJob(uploadId, { status: "completed", progress: 100, error: null });
        await setUpload(uploadId, { status: "completed" });
      });

      return { ok: true, uploadId, outputPath };
    } catch (err: any) {
      const message = safeErrMessage(err);

      debug.step = debug.step || "unknown";
      debug.failed_at = new Date().toISOString();
      debug.failure_message = message;

      try {
        await safeSetDebug();
        await setJob(uploadId, { status: "failed", error: message });
        await setUpload(uploadId, { status: "failed" });
      } catch {}

      throw new Error(message);
    }
  }
);
