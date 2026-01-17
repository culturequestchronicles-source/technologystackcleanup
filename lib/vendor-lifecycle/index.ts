// FILE: lib/vendor-lifecycle/index.ts
import type { VendorLifecycleResolver, VendorLifecycleResult } from "./types";
import { vendorKey, normalizeVendorName } from "./vendor-normalize";

import { resolveMicrosoftLifecycle } from "@/lib/vendor-lifecycle/microsoft";
import { resolveOracleLifecycle } from "@/lib/vendor-lifecycle/oracle";
import { resolveIbmLifecycle } from "@/lib/vendor-lifecycle/ibm";
import { resolveRedhatLifecycle } from "@/lib/vendor-lifecycle/redhat";
import { resolveVmwareLifecycle } from "@/lib/vendor-lifecycle/vmware";

function clean(v: any) {
  return (v ?? "").toString().trim();
}

function safeErrMessage(err: any) {
  return err?.message || err?.cause?.message || (typeof err === "string" ? err : "Unknown error");
}

async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const p = fn();
    const timeoutPromise = new Promise<T>((_, rej) =>
      controller.signal.addEventListener("abort", () => rej(new Error(`${label} timed out after ${ms}ms`)), { once: true })
    );
    return await Promise.race([p, timeoutPromise]);
  } finally {
    clearTimeout(t);
  }
}

const VENDOR_ALIASES: Record<string, string> = {
  msft: "microsoft",
  "microsoft corp": "microsoft",
  "microsoft corporation": "microsoft",

  "vm ware": "vmware",
  "vm-ware": "vmware",

  "red hat": "redhat",
  "redhat inc": "redhat",
  "red hat inc": "redhat",

  "international business machines": "ibm",
  "ibm corp": "ibm",

  "oracle corp": "oracle",
  "oracle corporation": "oracle",
};

const RESOLVERS: Record<string, VendorLifecycleResolver> = {
  microsoft: async (input) => {
    const r = await resolveMicrosoftLifecycle({
      canonical_name: input.canonical_name,
      normalized_version: input.normalized_version,
    });
    if (!r) return null;

    return {
      source: r.source,
      source_url: r.source_url,
      support_end: r.mainstream_end || "",
      eol_end: r.extended_end || "",
      notes: r.notes || "",
    };
  },

  oracle: resolveOracleLifecycle,
  ibm: resolveIbmLifecycle,
  redhat: resolveRedhatLifecycle,
  vmware: resolveVmwareLifecycle,
};

function normalizeVendorForRouting(vendor: string): string {
  const n = normalizeVendorName(clean(vendor)).toLowerCase();
  return VENDOR_ALIASES[n] || n;
}

export async function resolveVendorLifecycle(input: {
  canonical_name: string;
  canonical_vendor: string;
  normalized_version: string;
  service_pack?: string;
}): Promise<VendorLifecycleResult | null> {
  const canonical_name = clean(input.canonical_name);
  const canonical_vendor_raw = clean(input.canonical_vendor);
  const normalized_version = clean(input.normalized_version);

  if (!canonical_name) return null;

  const canonical_vendor = normalizeVendorForRouting(canonical_vendor_raw);
  const key = vendorKey(canonical_vendor);

  const resolver = RESOLVERS[key];
  if (!resolver) return null;

  try {
    const result = await withTimeout(`Vendor lifecycle resolver (${key})`, 12000, async () =>
      resolver({
        canonical_name,
        canonical_vendor,
        normalized_version,
        service_pack: clean(input.service_pack),
      })
    );

    if (!result) return null;

    return {
      source: clean(result.source),
      source_url: clean(result.source_url),
      support_end: clean(result.support_end),
      eol_end: clean(result.eol_end),
      notes: clean(result.notes),
    };
  } catch (e: any) {
    return {
      source: `vendor_lifecycle_error:${key}`,
      source_url: "",
      support_end: "",
      eol_end: "",
      notes: `Vendor resolver failed safely: ${safeErrMessage(e)}`,
    };
  }
}
