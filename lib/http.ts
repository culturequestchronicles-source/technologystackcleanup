// FILE: lib/http.ts
// Centralized, safe HTTP helpers so your pipeline never "hangs".
// Works in Next.js (Node runtime) and supports AbortSignal chaining.

export type FetchJsonResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

function safeErrMessage(err: any) {
  return (
    err?.message ||
    err?.cause?.message ||
    err?.error?.message ||
    (typeof err === "string" ? err : "Unknown error")
  );
}

export async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 12000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const headers = new Headers(opts.headers || {});
    if (!headers.has("User-Agent")) headers.set("User-Agent", "TechStackCleanupBot/1.0");

    return await fetch(url, {
      ...opts,
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function getJsonSafe<T>(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<FetchJsonResult<T>> {
  try {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${text?.slice(0, 200) || ""}`.trim() };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? `Request timed out` : safeErrMessage(e);
    return { ok: false, error: msg };
  }
}

export async function postJsonSafe<T>(
  url: string,
  body: any,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<FetchJsonResult<T>> {
  try {
    const headers = new Headers(opts.headers || {});
    headers.set("content-type", "application/json");
    if (!headers.has("User-Agent")) headers.set("User-Agent", "TechStackCleanupBot/1.0");

    const res = await fetchWithTimeout(url, {
      ...opts,
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${text?.slice(0, 200) || ""}`.trim() };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? `Request timed out` : safeErrMessage(e);
    return { ok: false, error: msg };
  }
}
