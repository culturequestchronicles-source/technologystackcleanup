// FILE: app/api/upload/route.ts
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { supabase } from "@/lib/supabase";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStoreHeaders() {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

/**
 * If UTF-8 decode produces many replacement chars (�) or NULs, it's likely wrong.
 */
function looksLikeBadUtf8(s: string) {
  if (!s) return true;
  const replacementCount = (s.match(/\uFFFD/g) || []).length; // �
  const nulCount = (s.match(/\u0000/g) || []).length;
  return replacementCount >= 3 || nulCount >= 1;
}

/**
 * Detect BOM for UTF-16 and decode safely.
 */
function decodePossiblyUtf16(buf: Buffer): string | null {
  if (buf.length < 2) return null;

  // UTF-16 LE BOM: FF FE
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le");
  }

  // UTF-16 BE BOM: FE FF (Node doesn't directly support utf16be)
  // We'll swap bytes and decode as utf16le.
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }

  return null;
}

/**
 * Normalize uploaded CSV bytes into clean UTF-8 text.
 * Handles UTF-8, UTF-16, and Excel ANSI-ish encodings (fallback latin1).
 */
function normalizeCsvToUtf8(buf: Buffer): { text: string; encoding: string; notes: string[] } {
  const notes: string[] = [];

  // 1) UTF-16 detection
  const utf16 = decodePossiblyUtf16(buf);
  if (utf16 !== null) {
    let t = utf16;
    // Remove BOM if present, remove NULs, normalize newlines
    t = t.replace(/^\uFEFF/, "");
    t = t.replace(/\u0000/g, "");
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    notes.push("Detected UTF-16 BOM; decoded as UTF-16 and normalized to UTF-8.");
    return { text: t, encoding: "utf16", notes };
  }

  // 2) Try UTF-8 first
  const utf8 = buf.toString("utf-8");
  if (!looksLikeBadUtf8(utf8)) {
    let t = utf8;
    t = t.replace(/^\uFEFF/, ""); // strip UTF-8 BOM if present
    t = t.replace(/\u0000/g, "");
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    notes.push("Decoded as UTF-8.");
    return { text: t, encoding: "utf8", notes };
  }

  // 3) Fallback: Excel "CSV (Comma delimited)" often behaves like Windows-1252.
  // latin1 is a practical approximation without extra dependencies.
  const latin1 = buf.toString("latin1");
  let t = latin1;
  t = t.replace(/^\uFEFF/, "");
  t = t.replace(/\u0000/g, "");
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  notes.push("UTF-8 looked invalid; fell back to latin1/Windows-1252-like decode and normalized to UTF-8.");

  return { text: t, encoding: "latin1", notes };
}

export async function POST(req: Request) {
  const headers = noStoreHeaders();

  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "Missing file" }, { status: 400, headers });
    }

    const uploadId = randomUUID();

    // Keep original name, but ensure it ends with .csv (helps consistent handling)
    const originalFilename = (file.name || "upload.csv").trim() || "upload.csv";
    const filename = originalFilename.toLowerCase().endsWith(".csv") ? originalFilename : `${originalFilename}.csv`;

    const storagePath = `uploads/${uploadId}/${filename}`;

    // 1) Create uploads row
    const { error: upErr } = await supabase.from("uploads").insert({
      id: uploadId,
      filename,
      storage_path: storagePath,
      status: "uploaded",
    });

    if (upErr) {
      return NextResponse.json({ ok: false, error: upErr.message }, { status: 500, headers });
    }

    // 2) Create jobs row (queued)
    const { error: jobErr } = await supabase.from("jobs").insert({
      upload_id: uploadId,
      status: "queued",
      progress: 0,
      error: null,
      // Optional: debug helps you see encoding issues from the UI
      debug: {
        upload_filename: filename,
        upload_content_type: file.type || "text/csv",
      },
    });

    if (jobErr) {
      return NextResponse.json({ ok: false, error: jobErr.message }, { status: 500, headers });
    }

    // 3) Read file bytes and normalize encoding to UTF-8 text
    const rawBuf = Buffer.from(await file.arrayBuffer());
    const normalized = normalizeCsvToUtf8(rawBuf);

    // Re-encode as UTF-8 bytes for storage
    const utf8Buf = Buffer.from(normalized.text, "utf-8");

    // 4) Upload normalized UTF-8 CSV to Supabase storage
    const { error: storageErr } = await supabase.storage.from("uploads").upload(storagePath, utf8Buf, {
      contentType: "text/csv; charset=utf-8",
      upsert: true,
    });

    if (storageErr) {
      await supabase.from("jobs").update({ status: "failed", error: storageErr.message }).eq("upload_id", uploadId);
      await supabase.from("uploads").update({ status: "failed" }).eq("id", uploadId);

      return NextResponse.json({ ok: false, error: storageErr.message }, { status: 500, headers });
    }

    // 5) Update debug with encoding info (helps troubleshooting)
    try {
      await supabase
        .from("jobs")
        .update({
          debug: {
            upload_filename: filename,
            upload_content_type: file.type || "text/csv",
            upload_detected_encoding: normalized.encoding,
            upload_encoding_notes: normalized.notes.join(" "),
            upload_bytes_in: rawBuf.length,
            upload_bytes_out_utf8: utf8Buf.length,
          },
        })
        .eq("upload_id", uploadId);
    } catch {
      // best effort only
    }

    // 6) Send idempotent event to Inngest
    await inngest.send({
      name: "upload/created",
      id: uploadId,
      data: { uploadId },
    });

    // 7) Return uploadId; UI should navigate to /results/:id
    return NextResponse.json({ ok: true, uploadId }, { headers });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Upload failed" }, { status: 500, headers });
  }
}
