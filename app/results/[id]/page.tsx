// FILE: app/results/[id]/page.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Job = {
  upload_id: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  error: string | null;
  debug?: any;

  outputExists?: boolean;
  csvReady?: boolean;
  outputPath?: string | null;

  // ✅ added (from updated /api/jobs)
  reviewReady?: boolean;
  reviewCount?: number;
};

type ReviewRow = {
  row_index: number;
  review_row_id?: string | null;
  data: Record<string, any>;
};

type ReviewApiResponse = {
  ok: boolean;
  uploadId: string;
  source?: "review_rows" | "csv";
  headers?: string[];
  rows?: Array<{
    row_index: number;
    rowId?: string;
    review_row_id?: string;
    data: Record<string, any>;
  }>;
  error?: string;
};

type FinalizeApiResponse = {
  ok: boolean;
  uploadId: string;
  storage_path?: string;
  source?: "review_rows" | "csv";
  error?: string;
};

function toBoolishTrue(v: any) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "1" || s === "YES";
}

function safeString(v: any) {
  return v === null || v === undefined ? "" : String(v);
}

export default function ResultsPage({ params }: { params: { id: string } }) {
  const uploadId = params.id;

  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(true);

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadProbeError, setDownloadProbeError] = useState<string | null>(null);

  const jobsPollRef = useRef<any>(null);
  const downloadPollRef = useRef<any>(null);

  const [onlyNeedsReview, setOnlyNeedsReview] = useState(true);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSource, setReviewSource] = useState<"review_rows" | "csv" | null>(null);

  const [reviewHeaders, setReviewHeaders] = useState<string[]>([]);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);

  const [edits, setEdits] = useState<Record<number, Record<string, any>>>({});

  const [finalizeLoading, setFinalizeLoading] = useState(false);
  const [finalizeMsg, setFinalizeMsg] = useState<string | null>(null);

  async function fetchJob() {
    try {
      const res = await fetch(`/api/jobs/${uploadId}`, { cache: "no-store" });
      const json = await res.json();

      if (json?.ok && json?.job) {
        const j = json.job as Job;
        setJob(j);
        setLoading(false);
        return j;
      }

      setLoading(false);
      return null;
    } catch {
      setLoading(false);
      return null;
    }
  }

  useEffect(() => {
    const run = async () => {
      const j = await fetchJob();

      if (j && (j.status === "queued" || j.status === "running")) {
        if (jobsPollRef.current) clearInterval(jobsPollRef.current);
        jobsPollRef.current = setInterval(fetchJob, 2000);
      }
    };

    run();

    return () => {
      if (jobsPollRef.current) clearInterval(jobsPollRef.current);
      if (downloadPollRef.current) clearInterval(downloadPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId]);

  const csvReady = !!(job?.csvReady ?? job?.outputExists);
  const reviewReady = !!job?.reviewReady;

  useEffect(() => {
    if (!job) return;
    if (job.status === "completed" || job.status === "failed") {
      if (jobsPollRef.current) {
        clearInterval(jobsPollRef.current);
        jobsPollRef.current = null;
      }
    }
  }, [job]);

  // Probe download signed URL until CSV exists (review rows can appear before export finishes)
  useEffect(() => {
    if (!job) return;
    if (job.status === "failed") return;

    // If csv already ready, no probe needed
    if (csvReady) {
      if (downloadPollRef.current) {
        clearInterval(downloadPollRef.current);
        downloadPollRef.current = null;
      }
      return;
    }

    const okToProbe = (job.progress ?? 0) >= 45 || job.status === "completed";
    if (!okToProbe) return;

    if (downloadPollRef.current) clearInterval(downloadPollRef.current);

    const tick = async () => {
      try {
        setDownloadProbeError(null);
        const res = await fetch(`/api/download/${uploadId}?json=1`, { cache: "no-store" });
        if (!res.ok) return;

        const json = await res.json();
        if (json?.ok && json?.url) {
          setDownloadUrl(json.url);
          if (downloadPollRef.current) {
            clearInterval(downloadPollRef.current);
            downloadPollRef.current = null;
          }
          await fetchJob();
        }
      } catch (e: any) {
        setDownloadProbeError(e?.message || "Download probe failed");
      }
    };

    tick();
    downloadPollRef.current = setInterval(tick, 2000);

    return () => {
      if (downloadPollRef.current) clearInterval(downloadPollRef.current);
      downloadPollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, job?.progress, csvReady, reviewReady, uploadId]);

  // ✅ canDownload means "CSV exists"
  const canDownload = csvReady || !!downloadUrl;

  // ✅ IMPORTANT: canReview means "review rows exist OR csv exists"
  const canReview = canDownload || reviewReady;

  const uiStatus: Job["status"] = job?.status || "running";

  const uiProgress = job?.progress || 0;

  const mappingView = useMemo(() => {
    const m = job?.debug?.header_mapping;
    if (!m) return null;

    return {
      technology: m.technologyKey,
      vendor: m.vendorKey,
      version: m.versionKey,
      endOfSupport: m.endOfSupportKey,
      endOfLife: m.endOfLifeKey,
      explanation: Array.isArray(m.explanation) ? m.explanation : [],
    };
  }, [job?.debug]);

  const editableKeys = [
    "canonical_name",
    "canonical_vendor",
    "normalized_version",
    "normalized_end_of_support",
    "normalized_end_of_life",
    "domain",
    "review_required",
    "validation_notes",
  ];

  const displayKeys = [
    "canonical_name",
    "canonical_vendor",
    "normalized_version",
    "domain",
    "confidence",
    "vendor_site_verified",
    "vendor_site_url",

    "input_eos",
    "input_eol",
    "corrected_eos",
    "corrected_eol",
    "lifecycle_source",

    "vuln_total",
    "vuln_top",
    "vuln_sources",
    "kev_flagged",

    "review_required",
    "validation_notes",
  ];

  async function loadReviewRows() {
    setReviewLoading(true);
    setReviewError(null);
    setFinalizeMsg(null);

    try {
      const url = `/api/review/${uploadId}?onlyNeedsReview=${onlyNeedsReview ? "1" : "0"}&limit=200`;
      const res = await fetch(url, { cache: "no-store" });
      const json = (await res.json()) as ReviewApiResponse;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `Failed to load review rows (status=${res.status})`);
      }

      setReviewSource(json.source || null);

      const rows: ReviewRow[] = (json.rows || []).map((r) => ({
        row_index: r.row_index,
        review_row_id: (r as any).review_row_id ?? (r as any).rowId ?? null,
        data: r.data || {},
      }));

      const headers = json.headers?.length ? json.headers : Object.keys(rows[0]?.data || {});
      setReviewHeaders(headers);
      setReviewRows(rows);
      setEdits({});
    } catch (e: any) {
      setReviewError(e?.message || "Failed to load review rows");
      setReviewSource(null);
      setReviewHeaders([]);
      setReviewRows([]);
      setEdits({});
    } finally {
      setReviewLoading(false);
    }
  }

  function setCell(rowIndex: number, key: string, value: any) {
    setEdits((prev) => ({
      ...prev,
      [rowIndex]: {
        ...(prev[rowIndex] || {}),
        [key]: value,
      },
    }));
  }

  function findRowByIndex(rowIndex: number) {
    return reviewRows.find((r) => r.row_index === rowIndex) || null;
  }

  async function saveRowPatchIfDb(rowIndex: number, patch: Record<string, any>) {
    if (reviewSource !== "review_rows") return;

    const row = findRowByIndex(rowIndex);
    const rowId = row?.review_row_id;
    if (!rowId) return;

    try {
      const allowed = new Set([
        "canonical_name",
        "canonical_vendor",
        "normalized_version",
        "normalized_end_of_support",
        "normalized_end_of_life",
        "domain",
        "validation_notes",
        "review_required",
        "is_approved",
      ]);

      const body: Record<string, any> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!allowed.has(k)) continue;
        if (k === "review_required" || k === "is_approved") body[k] = toBoolishTrue(v);
        else body[k] = v;
      }

      const res = await fetch(`/api/review/${uploadId}/row/${rowId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = await res.json();
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Save failed (status=${res.status})`);
    } catch (e: any) {
      setReviewError(e?.message || "Failed to save row edits");
    }
  }

  async function generateFinalCsv() {
    setFinalizeLoading(true);
    setFinalizeMsg(null);
    setReviewError(null);

    try {
      if (reviewSource === "review_rows") {
        const entries = Object.entries(edits);
        for (const [rowIndexStr, patch] of entries) {
          const rowIndex = Number(rowIndexStr);
          await saveRowPatchIfDb(rowIndex, patch);
        }
      }

      const res = await fetch(`/api/review/${uploadId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          edits: Object.entries(edits).map(([row_index, patch]) => ({
            row_index: Number(row_index),
            patch,
          })),
        }),
      });

      const json = (await res.json()) as FinalizeApiResponse;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Finalize failed (status=${res.status})`);

      setFinalizeMsg(`✅ FINAL CSV generated (${json.source || "unknown"}). Download link updated.`);
      setDownloadUrl(null);

      try {
        const probe = await fetch(`/api/download/${uploadId}?json=1`, { cache: "no-store" });
        if (probe.ok) {
          const p = await probe.json();
          if (p?.ok && p?.url) setDownloadUrl(p.url);
        }
      } catch {}

      await fetchJob();
    } catch (e: any) {
      setReviewError(e?.message || "Failed to generate FINAL CSV");
    } finally {
      setFinalizeLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Processing Status</h2>
        <p>Upload ID: {uploadId}</p>
        <p>Loading job…</p>
      </div>
    );
  }

  if (!job) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Processing Status</h2>
        <p>Upload ID: {uploadId}</p>
        <p>Could not load job status.</p>
      </div>
    );
  }

  const reviewButCsvMissing = reviewReady && !csvReady;

  return (
    <div style={{ padding: 24 }}>
      <h2>Processing Status</h2>
      <p>Upload ID: {uploadId}</p>

      <p>
        <strong>Status:</strong> {uiStatus}
      </p>

      <p>
        <strong>Progress:</strong> {uiProgress}%
      </p>

      {job.status === "failed" && job.error ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #f00" }}>
          <strong>Error:</strong> {job.error}
        </div>
      ) : null}

      {reviewButCsvMissing ? (
        <div style={{ marginTop: 12, padding: 12, border: "1px solid #f59e0b", borderRadius: 8 }}>
          <div style={{ fontWeight: 800 }}>Review rows are ready, but CSV output is missing.</div>
          <div style={{ marginTop: 6 }}>
            This means the AI step finished and wrote to <code>review_rows</code>, but the CSV upload step likely failed.
          </div>
          <div style={{ marginTop: 6 }}>
            ✅ You can still click <b>Load Review Rows</b> and then <b>Generate FINAL CSV</b> to produce the output.
          </div>
        </div>
      ) : null}

      {job.debug ? (
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Debug Info</summary>

          {mappingView ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Header Mapping</div>
              <div>Technology: {mappingView.technology}</div>
              <div>Vendor/Supplier: {mappingView.vendor}</div>
              <div>Version: {mappingView.version}</div>
              {mappingView.endOfSupport ? <div>End of Support: {mappingView.endOfSupport}</div> : null}
              {mappingView.endOfLife ? <div>End of Life: {mappingView.endOfLife}</div> : null}
            </div>
          ) : null}

          <pre
            style={{
              marginTop: 10,
              padding: 12,
              border: "1px solid #ddd",
              borderRadius: 8,
              whiteSpace: "pre-wrap",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontSize: 12,
            }}
          >
            {JSON.stringify(job.debug, null, 2)}
          </pre>
        </details>
      ) : null}

      {canDownload ? (
        <div style={{ marginTop: 16 }}>
          <a href={downloadUrl || `/api/download/${uploadId}`} style={{ fontWeight: 700 }}>
            Download CSV
          </a>
        </div>
      ) : null}

      {/* Phase 3: Review + Finalize */}
      <div style={{ marginTop: 28, padding: 16, border: "1px solid #ddd", borderRadius: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Review + Finalize (Phase 3)</div>
            <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>
              Load rows, edit key fields, then generate a FINAL CSV.
              {job.reviewReady ? (
                <div style={{ marginTop: 4 }}>
                  Review rows ready: <b>{job.reviewCount ?? "?"}</b>
                </div>
              ) : null}
            </div>
          </div>

          <button
            onClick={loadReviewRows}
            disabled={!canReview || reviewLoading}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #333",
              cursor: !canReview || reviewLoading ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
            title={!canReview ? "Wait until review rows or CSV are ready" : "Load review rows"}
          >
            {reviewLoading ? "Loading…" : "Load Review Rows"}
          </button>
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={onlyNeedsReview}
              onChange={(e) => setOnlyNeedsReview(e.target.checked)}
            />
            Only rows needing review (review_required=TRUE)
          </label>

          {reviewError ? (
            <div style={{ marginTop: 10, padding: 10, border: "1px solid #f00", borderRadius: 8 }}>{reviewError}</div>
          ) : null}

          {finalizeMsg ? (
            <div style={{ marginTop: 10, padding: 10, border: "1px solid #16a34a", borderRadius: 8 }}>
              {finalizeMsg}
            </div>
          ) : null}
        </div>

        {reviewRows.length ? (
          <>
            <div style={{ marginTop: 12, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", minWidth: 1100, width: "100%" }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Row</th>
                    {displayKeys.map((k) => (
                      <th key={k} style={thStyle}>
                        {k}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reviewRows.map((r) => {
                    const rowEdit = edits[r.row_index] || {};
                    const merged = { ...(r.data || {}), ...rowEdit };

                    return (
                      <tr key={r.row_index}>
                        <td style={tdStyle}>
                          <b>{r.row_index}</b>
                        </td>

                        {displayKeys.map((key) => {
                          const isEditable = editableKeys.includes(key);

                          if (!isEditable) {
                            return (
                              <td key={key} style={tdStyle}>
                                {safeString(merged[key])}
                              </td>
                            );
                          }

                          if (key === "review_required") {
                            return (
                              <td key={key} style={tdStyle}>
                                <select
                                  value={toBoolishTrue(merged[key]) ? "TRUE" : "FALSE"}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setCell(r.row_index, key, v);
                                    saveRowPatchIfDb(r.row_index, { [key]: v });
                                  }}
                                  style={inputStyle}
                                >
                                  <option value="TRUE">TRUE</option>
                                  <option value="FALSE">FALSE</option>
                                </select>
                              </td>
                            );
                          }

                          return (
                            <td key={key} style={tdStyle}>
                              <input
                                value={safeString(merged[key])}
                                onChange={(e) => setCell(r.row_index, key, e.target.value)}
                                onBlur={() => {
                                  const rowEditNow = edits[r.row_index] || {};
                                  const val = rowEditNow[key] ?? merged[key];
                                  saveRowPatchIfDb(r.row_index, { [key]: safeString(val) });
                                }}
                                style={inputStyle}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={generateFinalCsv}
                disabled={finalizeLoading || !canReview}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #333",
                  cursor: finalizeLoading || !canReview ? "not-allowed" : "pointer",
                  fontWeight: 800,
                }}
              >
                {finalizeLoading ? "Generating…" : "Generate FINAL CSV"}
              </button>

              <span style={{ fontSize: 12, color: "#555" }}>
                Edits queued: <b>{Object.keys(edits).length}</b>
              </span>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 10, fontSize: 12, color: "#555" }}>
            Load review rows once your review rows or CSV are ready.
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  borderBottom: "1px solid #ddd",
  padding: "8px 6px",
  fontSize: 12,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #eee",
  padding: "6px",
  fontSize: 12,
  verticalAlign: "top",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #ddd",
  borderRadius: 6,
  fontSize: 12,
  fontFamily: "inherit",
};
