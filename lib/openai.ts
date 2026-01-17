// FILE: lib/openai.ts
import OpenAI from "openai";
import http from "http";
import https from "https";

export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || "20000");
const MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || "0");

// Keep-alive agents reduce intermittent socket stalls
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const fetchWithAgent: typeof fetch = (input: any, init?: any) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input?.url;

  const isHttps = typeof url === "string" && url.startsWith("https://");
  return fetch(input, {
    ...init,
    // @ts-expect-error Node fetch supports "agent" at runtime
    agent: isHttps ? httpsAgent : httpAgent,
  });
};

let _client: OpenAI | null = null;

export function getOpenAIClient() {
  if (_client) return _client;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY (set it in Vercel env vars / .env.local)");
  }

  const baseURL = process.env.OPENAI_BASE_URL || undefined;

  _client = new OpenAI({
    apiKey,
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    fetch: fetchWithAgent,
  });

  return _client;
}

// Convenience export (some files like to import `openai`)
export const openai = {
  chat: {
    completions: {
      create: (...args: Parameters<OpenAI["chat"]["completions"]["create"]>) =>
        getOpenAIClient().chat.completions.create(...args),
    },
  },
};
