// FILE: lib/vendor-lifecycle/types.ts
export type VendorLifecycleResult = {
    source: string; // e.g. "microsoft_lifecycle", "oracle_lifetime_support"
    source_url: string;
  
    // We map to your pipeline fields:
    // corrected_eos = support end (often "mainstream/premier end")
    // corrected_eol = end-of-life / end-of-support (often "extended end")
    support_end: string; // YYYY-MM-DD
    eol_end: string;     // YYYY-MM-DD
  
    notes: string;
  };
  
  export type VendorLifecycleResolver = (input: {
    canonical_name: string;
    canonical_vendor: string;
    normalized_version: string;
    service_pack?: string;
  }) => Promise<VendorLifecycleResult | null>;
  