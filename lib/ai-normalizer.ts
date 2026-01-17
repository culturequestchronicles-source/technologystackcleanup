// FILE: lib/ai-normalizer.ts
import { getOpenAIClient, OPENAI_MODEL } from "@/lib/openai";

export type AiNormalized = {
  canonical_name: string;
  canonical_vendor: string | null;
  normalized_version: string | null;

  normalized_end_of_support: string | null;
  normalized_end_of_life: string | null;

  domain: string | null;
  confidence: number;
  notes: string | null;
};

function clean(v: any) {
  return (v ?? "").toString().trim();
}

function toNullable(v: any): string | null {
  const s = clean(v);
  return s ? s : null;
}

function clamp01(n: number, fallback = 0.6) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function safeErrMessage(err: any) {
  return (
    err?.message ||
    err?.cause?.message ||
    err?.error?.message ||
    (typeof err === "string" ? err : "Unknown error")
  );
}

/**
 * Deterministic "cheap fixes" BEFORE AI.
 * These improve success rate + reduce dependence on AI.
 */
function preNormalize(input: {
  technology: string;
  vendor: string | null;
  version: string | null;
  end_of_support: string | null;
  end_of_life: string | null;
}) {
  let technology = clean(input.technology);
  let vendor = clean(input.vendor);
  let version = clean(input.version);

  // common typos
  technology = technology.replace(/\bngix\b/gi, "nginx");
  technology = technology.replace(/\bpythn\b/gi, "python");

  // vendor aliases
  vendor = vendor.replace(/\bMSFT\b/gi, "Microsoft");
  vendor = vendor.replace(/\bMFST\b/gi, "Microsoft");
  vendor = vendor.replace(/\bMICROSOFT CORP\.?\b/gi, "Microsoft");
  vendor = vendor.replace(/\boracle\b/gi, "Oracle");

  // year shorthand: 2k16 -> 2016
  version = version.replace(/\b2k(\d{2})\b/gi, (_m, yy) => `20${yy}`);

  // remove leading v (v 3.9.1 -> 3.9.1)
  version = version.replace(/^\s*v\s*/i, "");

  return {
    technology,
    vendor: vendor || null,
    version: version || null,
    end_of_support: toNullable(input.end_of_support),
    end_of_life: toNullable(input.end_of_life),
  };
}

/**
 * Strict JSON extractor:
 * - If model returns extra text, try to extract the first {...} block.
 */
function extractJsonObject(text: string): any {
  const t = clean(text);
  if (!t) return {};

  try {
    return JSON.parse(t);
  } catch {
    // try to extract a JSON object substring
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sub = t.slice(start, end + 1);
      try {
        return JSON.parse(sub);
      } catch {
        return {};
      }
    }
    return {};
  }
}

/**
 * Hard timeout wrapper that DOES NOT rely solely on AbortSignal support.
 */
async function withHardTimeout<T>(label: string, ms: number, fn: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);

  try {
    const p = fn(controller.signal);
    const timeoutPromise = new Promise<T>((_, rej) =>
      controller.signal.addEventListener("abort", () => rej(new Error(`${label} timed out after ${ms}ms`)), { once: true })
    );

    return await Promise.race([p, timeoutPromise]);
  } finally {
    clearTimeout(t);
  }
}

const AI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || "20000"); // already in openai.ts, but use here too
const AI_RETRIES = Math.min(2, Math.max(0, Number(process.env.OPENAI_MAX_RETRIES || "0"))); // 0-2

export async function normalizeTechRowAI(
  input: {
    technology: string;
    vendor: string | null;
    version: string | null;
    end_of_support: string | null;
    end_of_life: string | null;
  },
  opts?: { signal?: AbortSignal }
): Promise<AiNormalized> {
  const pre = preNormalize(input);

  // If upstream already aborted, return fast.
  if (opts?.signal?.aborted) {
    return {
      canonical_name: pre.technology || clean(input.technology) || "",
      canonical_vendor: pre.vendor || toNullable(input.vendor),
      normalized_version: pre.version || toNullable(input.version),
      normalized_end_of_support: toNullable(pre.end_of_support ?? input.end_of_support),
      normalized_end_of_life: toNullable(pre.end_of_life ?? input.end_of_life),
      domain: null,
      confidence: 0.5,
      notes: "Skipped AI: aborted.",
    };
  }

  const prompt = `
Normalize one software inventory row.
Return ONLY JSON with keys:
canonical_name, canonical_vendor, normalized_version,
normalized_end_of_support, normalized_end_of_life,
domain, confidence, notes

Rules:
- Fix obvious typos (ngix -> nginx).
- Normalize vendor aliases (MFST/MSFT -> Microsoft).
- Normalize shorthand years (2k16 -> 2016).
- Versions: keep semantic intent; do not invent.
- Dates:
  - If end_of_support/end_of_life are provided, keep them as YYYY-MM-DD.
  - If empty, return null.
  - DO NOT invent/guess EOS/EOL.
- domain should be one of: database, webserver, runtime/framework, programming, os, container, middleware, software, security, devops, other
- confidence must be between 0 and 1.

Input:
technology=${JSON.stringify(pre.technology)}
vendor=${JSON.stringify(pre.vendor)}
version=${JSON.stringify(pre.version)}
end_of_support=${JSON.stringify(pre.end_of_support)}
end_of_life=${JSON.stringify(pre.end_of_life)}
`.trim();

  let lastErr = "";

  for (let attempt = 0; attempt <= AI_RETRIES; attempt++) {
    try {
      const resp = await withHardTimeout(`OpenAI normalize (attempt ${attempt + 1})`, AI_TIMEOUT_MS, async (signal) => {
        // Chain external abort into our internal signal
        if (opts?.signal) {
          if (opts.signal.aborted) signal.throwIfAborted?.();
          opts.signal.addEventListener("abort", () => (signal as any).abort?.(), { once: true });
        }

        const openai = getOpenAIClient();
return await openai.chat.completions.create(
          {
            model: OPENAI_MODEL,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "Return strict JSON only." },
              { role: "user", content: prompt },
            ],
          },
          { signal } // pass AbortSignal
        );
      });

      const content = resp.choices?.[0]?.message?.content || "{}";
      const parsed = extractJsonObject(content);

      const confidence = clamp01(Number(parsed.confidence), 0.6);

      return {
        canonical_name: clean(parsed.canonical_name || pre.technology || input.technology || ""),
        canonical_vendor: toNullable(parsed.canonical_vendor ?? pre.vendor ?? input.vendor),
        normalized_version: toNullable(parsed.normalized_version ?? pre.version ?? input.version),

        normalized_end_of_support: toNullable(parsed.normalized_end_of_support ?? pre.end_of_support ?? input.end_of_support),
        normalized_end_of_life: toNullable(parsed.normalized_end_of_life ?? pre.end_of_life ?? input.end_of_life),

        domain: toNullable(parsed.domain),
        confidence,
        notes: toNullable(parsed.notes) || null,
      };
    } catch (e: any) {
      lastErr = safeErrMessage(e);

      // If it's a timeout or abort, do not retry much—move on quickly.
      const msg = (lastErr || "").toLowerCase();
      const isTimeout = msg.includes("timed out");
      const isAbort = msg.includes("abort");

      if (attempt >= AI_RETRIES || isAbort) break;

      // quick small backoff
      if (isTimeout) {
        await new Promise((r) => setTimeout(r, 250));
      } else {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  // Fallback result (never block the pipeline)
  return {
    canonical_name: pre.technology || clean(input.technology) || "",
    canonical_vendor: pre.vendor || toNullable(input.vendor),
    normalized_version: pre.version || toNullable(input.version),

    normalized_end_of_support: toNullable(pre.end_of_support ?? input.end_of_support),
    normalized_end_of_life: toNullable(pre.end_of_life ?? input.end_of_life),

    domain: null,
    confidence: 0.55,
    notes: `AI failed: ${lastErr}`.trim(),
  };
}
