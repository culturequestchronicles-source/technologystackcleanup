// FILE: utils/csv-export.ts
function normalizeForCsv(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function escapeCsv(v: any) {
  const s = normalizeForCsv(v);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\t")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Excel-friendly UTF-8 BOM */
export function withUtf8Bom(csv: string) {
  return "\uFEFF" + (csv || "");
}

export function buildCsvOrdered(
  rows: Array<Record<string, any>>,
  originalHeaders: string[],
  extraHeadersPreferredOrder: string[]
): string {
  if (!rows?.length) return "";

  const allKeys = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => allKeys.add(k)));

  const original = (originalHeaders || []).filter((h) => allKeys.has(h));
  const extrasPreferred = (extraHeadersPreferredOrder || []).filter((h) => allKeys.has(h));

  const already = new Set([...original, ...extrasPreferred]);
  const remaining = [...allKeys].filter((k) => !already.has(k)).sort();

  const headers = [...original, ...extrasPreferred, ...remaining];

  const lines: string[] = [];
  lines.push(headers.map(escapeCsv).join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCsv(r[h])).join(","));
  }
  return lines.join("\n");
}
