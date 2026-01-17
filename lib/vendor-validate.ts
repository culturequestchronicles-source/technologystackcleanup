// FILE: lib/vendor-validate.ts

export type VendorSiteSignal = {
  vendor_input: string;
  vendor_canonical: string;

  vendor_site_url: string | null; // https://...
  vendor_site_verified: boolean;  // true if we got a 2xx/3xx response
  vendor_signal_notes: string;    // human-readable explanation
  confidence_boost: number;       // 0..0.10 (cap)
};

const MAX_BOOST_MAPPED = 0.06;
const MAX_BOOST_GUESSED = 0.02;

// Better curated mapping (prevents bad guessing)
const VENDOR_DOMAIN_MAP: Record<string, string> = {
  microsoft: "microsoft.com",
  "microsoft corporation": "microsoft.com",
  msft: "microsoft.com",
  mfst: "microsoft.com",

  oracle: "oracle.com",
  ibm: "ibm.com",
  google: "google.com",
  "google llc": "google.com",

  "amazon web services": "aws.amazon.com",
  aws: "aws.amazon.com",

  redhat: "redhat.com",
  "red hat": "redhat.com",
  vmware: "vmware.com",
  broadcom: "broadcom.com",

  nginx: "nginx.com",
  apache: "apache.org",

  docker: "docker.com",
  "docker inc": "docker.com",
  "docker, inc": "docker.com",

  mongodb: "mongodb.com",
  postgresql: "postgresql.org",
  mysql: "mysql.com",
};

function normalizeVendorKey(v: string) {
  return (v || "")
    .trim()
    .toLowerCase()
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Conservative domain guess:
 * - Only guesses when vendor is a SINGLE WORD brand-like name
 * - Avoids "Docker Inc" -> dockerinc.com type mistakes
 */
function guessDomainFromVendor(vendor: string): string | null {
  const normalized = normalizeVendorKey(vendor);
  if (!normalized) return null;

  // if it contains spaces, we do NOT guess (too risky)
  if (normalized.includes(" ")) return null;

  // too short -> no
  if (normalized.length < 3) return null;

  // only safe chars
  if (!/^[a-z0-9\-]+$/.test(normalized)) return null;

  return `${normalized}.com`;
}

/**
 * SSRF safety: block internal/localhost-like domains and IPs.
 */
function isUnsafeHost(host: string): boolean {
  const h = (host || "").trim().toLowerCase();
  if (!h) return true;

  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;

  const ipv4 = h.match(/^(\d{1,3}\.){3}\d{1,3}$/);
  if (ipv4) {
    const parts = h.split(".").map((x) => Number(x));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;

    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }

  return false;
}

async function fetchWithTimeout(url: string, ms: number, method: "HEAD" | "GET"): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "TechStackCleanupBot/1.0" },
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Try https HEAD, then https GET, then http HEAD as last resort.
 * Always returns within timeout limits (never hangs).
 */
export async function validateVendorWebsite(opts: {
  vendor_input: string | null | undefined;
  vendor_canonical: string | null | undefined;
  timeout_ms?: number; // default 4000
}): Promise<VendorSiteSignal> {
  const timeout_ms = opts.timeout_ms ?? 4000;

  const vendor_input = (opts.vendor_input || "").trim();
  const vendor_canonical = (opts.vendor_canonical || vendor_input || "").trim();

  const key = normalizeVendorKey(vendor_canonical || vendor_input);
  const mappedDomain = key ? VENDOR_DOMAIN_MAP[key] : undefined;

  const guessedDomain = !mappedDomain ? guessDomainFromVendor(vendor_canonical || vendor_input) : null;

  const candidates = [mappedDomain, guessedDomain].filter(Boolean) as string[];

  if (!candidates.length) {
    return {
      vendor_input,
      vendor_canonical,
      vendor_site_url: null,
      vendor_site_verified: false,
      vendor_signal_notes: "No vendor domain mapping/guess available.",
      confidence_boost: 0,
    };
  }

  const safeCandidates = candidates.filter((d) => !isUnsafeHost(d));
  if (!safeCandidates.length) {
    return {
      vendor_input,
      vendor_canonical,
      vendor_site_url: null,
      vendor_site_verified: false,
      vendor_signal_notes: "Vendor domain candidates were blocked by safety rules.",
      confidence_boost: 0,
    };
  }

  for (const domain of safeCandidates) {
    const isMapped = !!mappedDomain && domain === mappedDomain;

    const httpsUrl = `https://${domain}`;
    try {
      const head = await fetchWithTimeout(httpsUrl, timeout_ms, "HEAD");
      if (head.ok || (head.status >= 300 && head.status < 400)) {
        return {
          vendor_input,
          vendor_canonical,
          vendor_site_url: httpsUrl,
          vendor_site_verified: true,
          vendor_signal_notes: isMapped
            ? "Matched vendor to known official domain map (HTTPS)."
            : "Vendor domain guessed and verified reachable (HTTPS).",
          confidence_boost: isMapped ? MAX_BOOST_MAPPED : MAX_BOOST_GUESSED,
        };
      }

      // Some sites block HEAD. Try GET.
      const get = await fetchWithTimeout(httpsUrl, timeout_ms, "GET");
      if (get.ok || (get.status >= 300 && get.status < 400)) {
        return {
          vendor_input,
          vendor_canonical,
          vendor_site_url: httpsUrl,
          vendor_site_verified: true,
          vendor_signal_notes: isMapped
            ? "Matched vendor to known official domain map (HTTPS GET fallback)."
            : "Vendor domain guessed and verified reachable (HTTPS GET fallback).",
          confidence_boost: isMapped ? MAX_BOOST_MAPPED : MAX_BOOST_GUESSED,
        };
      }
    } catch {
      // ignore and try next candidate
    }

    // HTTP fallback (rare)
    const httpUrl = `http://${domain}`;
    try {
      const head = await fetchWithTimeout(httpUrl, timeout_ms, "HEAD");
      if (head.ok || (head.status >= 300 && head.status < 400)) {
        return {
          vendor_input,
          vendor_canonical,
          vendor_site_url: httpUrl,
          vendor_site_verified: true,
          vendor_signal_notes: isMapped
            ? "Matched vendor to known official domain map (HTTP fallback)."
            : "Vendor domain guessed and verified reachable (HTTP fallback).",
          confidence_boost: isMapped ? Math.min(MAX_BOOST_MAPPED, 0.04) : Math.min(MAX_BOOST_GUESSED, 0.01),
        };
      }
    } catch {
      // ignore
    }
  }

  // Return stable url (for visibility) even if not verified
  const fallbackUrl = `https://${safeCandidates[0]}`;
  return {
    vendor_input,
    vendor_canonical,
    vendor_site_url: fallbackUrl,
    vendor_site_verified: false,
    vendor_signal_notes: "Tried vendor site candidates but none responded quickly/cleanly.",
    confidence_boost: 0,
  };
}
