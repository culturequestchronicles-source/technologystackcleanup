// FILE: lib/cleaner.ts
import type { HeaderMapping } from "./header-detector";

export type CleanedRow = {
  cleaned: Record<string, any>;
  canonical: {
    technology: string;
    vendor: string;
    version: string;
    end_of_support: string; // YYYY-MM-DD or ""
    end_of_life: string;    // YYYY-MM-DD or ""
  };
  review_required: boolean;
  validation_notes: string;
};

function toStr(v: any) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// Allow common enterprise tokens in versions (so we don't over-flag)
function looksLikeSuspiciousVersion(v: string) {
  if (!v) return false;

  // Allow common enterprise tokens without marking suspicious:
  // SP3, R2, CU12, KB5001234, Update 3, etc.
  const cleaned = v
    .replace(/\bSP\s*\d+\b/gi, "")       // Service Pack
    .replace(/\bR2\b/gi, "")             // Windows Server R2
    .replace(/\bCU\s*\d+\b/gi, "")       // Cumulative Update
    .replace(/\bKB\s*\d+\b/gi, "")       // Microsoft KB
    .replace(/\bUPDATE\s*\d+\b/gi, "")   // Update 1/2/3
    .trim();

  // If letters remain after removing allowed tokens, then it’s suspicious
  if (!cleaned) return false;
  return /[a-zA-Z]/.test(cleaned);
}

// Mixed formats support:
// - 12/29/2021 => MM/DD/YYYY
// - 21/10/2020 => DD/MM/YYYY
function normalizeDateToISO(input: string): { iso: string; ok: boolean } {
  const s = (input || "").trim();
  if (!s) return { iso: "", ok: true };

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { iso: s, ok: true };

  const datePart = s.split(" ")[0]?.trim() || s;
  const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const yyyy = m[3];

    let mm = a;
    let dd = b;

    if (a > 12 && b <= 12) {
      dd = a; mm = b;
    } else if (b > 12 && a <= 12) {
      mm = a; dd = b;
    } else {
      mm = a; dd = b;
    }

    const MM = String(mm).padStart(2, "0");
    const DD = String(dd).padStart(2, "0");
    return { iso: `${yyyy}-${MM}-${DD}`, ok: true };
  }

  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return { iso: "", ok: false };

  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { iso: `${yyyy}-${mm}-${dd}`, ok: true };
}

export function cleanRows(rows: Array<Record<string, any>>, mapping: HeaderMapping): CleanedRow[] {
  return rows.map((r) => {
    const cleaned: Record<string, any> = { ...r };

    for (const k of Object.keys(cleaned)) {
      const v = cleaned[k];
      if (typeof v === "string") cleaned[k] = v.trim();
    }

    const technology = mapping.technologyKey ? toStr(r[mapping.technologyKey]) : "";
    const vendor = mapping.vendorKey ? toStr(r[mapping.vendorKey]) : "";
    const version = mapping.versionKey ? toStr(r[mapping.versionKey]) : "";

    const eosRaw = mapping.endOfSupportKey ? toStr(r[mapping.endOfSupportKey]) : "";
    const eolRaw = mapping.endOfLifeKey ? toStr(r[mapping.endOfLifeKey]) : "";

    const eos = normalizeDateToISO(eosRaw);
    const eol = normalizeDateToISO(eolRaw);

    const notes: string[] = [];
    let review = false;

    if (!mapping.technologyKey) { review = true; notes.push("Could not detect technology column."); }
    if (!mapping.vendorKey) { review = true; notes.push("Could not detect vendor/supplier column."); }
    if (!mapping.versionKey) { review = true; notes.push("Could not detect version column."); }

    if (mapping.vendorKey && !vendor) { review = true; notes.push("Missing vendor/supplier."); }
    if (mapping.technologyKey && !technology) { review = true; notes.push("Missing technology name."); }
    if (mapping.versionKey && looksLikeSuspiciousVersion(version)) {
      review = true;
      notes.push("Suspicious version format (unexpected letters).");
    }

    if (eosRaw && !eos.ok) { review = true; notes.push("End of Support date could not be parsed."); }
    if (eolRaw && !eol.ok) { review = true; notes.push("End of Life date could not be parsed."); }

    return {
      cleaned,
      canonical: {
        technology,
        vendor,
        version,
        end_of_support: eos.iso,
        end_of_life: eol.iso,
      },
      review_required: review,
      validation_notes: notes.join(" ").trim(),
    };
  });
}
