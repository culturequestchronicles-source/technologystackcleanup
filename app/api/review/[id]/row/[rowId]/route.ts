// FILE: app/api/review/[id]/row/[rowId]/route.ts
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function isUuidLike(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function toBool(v: any): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toUpperCase();
  if (s === "TRUE" || s === "1" || s === "YES") return true;
  if (s === "FALSE" || s === "0" || s === "NO") return false;
  return undefined;
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; rowId: string } }
) {
  const uploadId = params.id;
  const rowId = params.rowId;

  if (!isUuidLike(uploadId) || !isUuidLike(rowId)) {
    return NextResponse.json({ ok: false, error: "Invalid id format" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // Only allow safe editable fields
  const allowed = [
    "canonical_name",
    "canonical_vendor",
    "normalized_version",
    "normalized_end_of_support",
    "normalized_end_of_life",
    "domain",
    "validation_notes",
    "review_required",
    "is_approved",
  ] as const;

  const editable: Record<string, any> = {};
  for (const k of allowed) {
    if (!(k in body)) continue;

    // Normalize booleans if they come in as strings
    if (k === "review_required" || k === "is_approved") {
      const b = toBool((body as any)[k]);
      if (b !== undefined) editable[k] = b;
      continue;
    }

    editable[k] = (body as any)[k];
  }

  if (Object.keys(editable).length === 0) {
    return NextResponse.json({ ok: false, error: "No editable fields provided" }, { status: 400 });
  }

  // Read existing edited_fields so we MERGE (don’t overwrite)
  const { data: existing, error: existingErr } = await supabase
    .from("review_rows")
    .select("edited_fields")
    .eq("upload_id", uploadId)
    .eq("id", rowId)
    .maybeSingle();

  if (existingErr) {
    return NextResponse.json({ ok: false, error: existingErr.message }, { status: 500 });
  }

  const prevEdited = (existing?.edited_fields && typeof existing.edited_fields === "object")
    ? existing.edited_fields
    : {};

  const edited_fields = {
    ...prevEdited,
    ...Object.keys(editable).reduce((acc, k) => {
      acc[k] = true;
      return acc;
    }, {} as Record<string, boolean>),
  };

  const { data, error } = await supabase
    .from("review_rows")
    .update({
      ...editable,
      edited_fields,
      updated_at: new Date().toISOString(),
    })
    .eq("upload_id", uploadId)
    .eq("id", rowId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, row: data });
}
