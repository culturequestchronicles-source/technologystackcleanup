// FILE: app/api/inngest/route.ts
import { serve } from "inngest/next";
import { NextRequest, NextResponse } from "next/server";

import { inngest } from "@/inngest/client";
import { processUpload } from "@/inngest/process-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = serve({
  client: inngest,
  functions: [processUpload],
});

export const GET = handler.GET;
export const POST = handler.POST;

export async function PUT(req: NextRequest) {
  // Inngest sometimes sends PUT with an empty body.
  // The SDK tries to parse JSON and throws "Unexpected end of JSON input".
  const contentLength = req.headers.get("content-length");
  const contentType = req.headers.get("content-type");

  const isEmptyBody =
    contentLength === "0" ||
    contentLength === null ||
    contentLength === undefined;

  const looksLikeJson =
    (contentType || "").toLowerCase().includes("application/json");

  // If it’s empty OR not JSON, just ACK it safely.
  if (isEmptyBody || !looksLikeJson) {
    return NextResponse.json({ ok: true });
  }

  // Otherwise, forward the request to Inngest's real PUT handler
  return handler.PUT(req);
}
