// FILE: lib/lifecycle-ai-from-evidence.ts
import { openai, OPENAI_MODEL } from "@/lib/openai";
import type { WebSearchResponse } from "@/lib/websearch/types";

export type EvidenceLifecycleResult = {
  ok: boolean;

  // These are your two main columns
  support_end: string; // YYYY-MM-DD or ""
  eol_end: string; // YYYY-MM-DD or ""

  // Evidence
  source: "websearch_ai";
  evidence_url: string;
  evidence_title: string;
  retrieved_at: string;

  notes: string;
};

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function extractLifecycleFromEvidence(input: {
  canonical_vendor: string;
  canonical_name: string;
  normalized_version: string;
  evidence: WebSearchResponse;
}): Promise<EvidenceLifecycleResult | null> {
  const { canonical_vendor, canonical_name, normalized_version, evidence } = input;

  if (!evidence?.results?.length) return null;

  const evidencePack = evidence.results.slice(0, 5).map((r, i) => ({
    i: i + 1,
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));

  const prompt = `
You are an enterprise-grade lifecycle extractor.

RULES (critical):
- Use ONLY the evidence snippets provided.
- DO NOT guess. If the evidence does not contain a date, output "".
- Dates MUST be YYYY-MM-DD when possible.
- support_end = "end of support" / "extended support end" / "support ends"
- eol_end = "end of life" / "end-of-life" / "eol"
- If there is only one lifecycle date and it is clearly the "extended support end", put it in support_end.
- Choose ONE best evidence URL that contains the date(s). If none contain dates, return ok=false.

INPUT:
vendor: ${canonical_vendor}
product: ${canonical_name}
version: ${normalized_version}

EVIDENCE (top results):
${JSON.stringify(evidencePack, null, 2)}

Return JSON ONLY in this schema:
{
  "ok": true/false,
  "support_end": "YYYY-MM-DD or empty",
  "eol_end": "YYYY-MM-DD or empty",
  "evidence_url": "string",
  "evidence_title": "string",
  "notes": "short explanation referencing evidence item number"
}
`.trim();

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.choices?.[0]?.message?.content || "";
  const json = safeJsonParse(text);
  if (!json || typeof json !== "object") return null;

  const ok = !!json.ok;
  const support_end = (json.support_end || "").toString().trim();
  const eol_end = (json.eol_end || "").toString().trim();
  const evidence_url = (json.evidence_url || "").toString().trim();
  const evidence_title = (json.evidence_title || "").toString().trim();
  const notes = (json.notes || "").toString().trim();

  if (!ok) return null;
  if (!evidence_url) return null;

  return {
    ok: true,
    support_end,
    eol_end,
    source: "websearch_ai",
    evidence_url,
    evidence_title,
    retrieved_at: evidence.retrieved_at,
    notes,
  };
}
