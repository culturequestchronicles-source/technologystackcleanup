import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.NVD_API_KEY;

  if (!key) {
    return NextResponse.json(
      { ok: false, error: "Missing NVD_API_KEY in .env.local" },
      { status: 400 }
    );
  }

  // Simple, known CVE to test connectivity.
  // This call should return 200 if the key works.
  const url = "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228";

  const resp = await fetch(url, {
    headers: {
      "apiKey": key, // NVD expects header name "apiKey"
      "User-Agent": "technologystackcleanup-dev-test",
    },
  });

  const text = await resp.text();

  // Return status + small preview (not entire payload)
  return NextResponse.json({
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    bodyPreview: text.slice(0, 400),
  });
}
