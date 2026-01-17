// FILE: utils/file-parser.ts
import Papa from "papaparse";

export type ParsedRow = { rowIndex: number; data: Record<string, any> };

function countMatches(s: string, re: RegExp) {
  return (s.match(re) || []).length;
}

// Detect Excel/Windows encoding weirdness
function looksLikeBadText(s: string) {
  if (!s) return true;
  const replacementCount = countMatches(s, /\uFFFD/g); // �
  const nulCount = countMatches(s, /\u0000/g);
  // Too many replacement chars or any NULs = wrong decoding
  return replacementCount >= 3 || nulCount >= 1;
}

function stripBom(text: string) {
  // Remove UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

function toBuffer(input: ArrayBuffer | Buffer | Uint8Array | string): Buffer {
  if (typeof input === "string") return Buffer.from(input, "utf-8");
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(new Uint8Array(input));
}

function decodeUtf16IfBom(buf: Buffer): string | null {
  if (buf.length < 2) return null;

  // UTF-16 LE BOM: FF FE
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString("utf16le");
  }

  // UTF-16 BE BOM: FE FF (Node doesn’t have utf16be, so swap bytes then utf16le)
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }

  return null;
}

function toText(input: ArrayBuffer | Buffer | Uint8Array | string): string {
  if (typeof input === "string") return stripBom(input);

  const buf = toBuffer(input);

  // 1) UTF-16 BOM handling (critical for Excel weird exports)
  const utf16 = decodeUtf16IfBom(buf);
  if (utf16 !== null) return stripBom(utf16);

  // 2) Try UTF-8
  const utf8 = buf.toString("utf-8");
  if (!looksLikeBadText(utf8)) return stripBom(utf8);

  // 3) Fallback: Windows-1252-ish (latin1 is best we can do without extra deps)
  const latin1 = buf.toString("latin1");
  return stripBom(latin1);
}

export function parseCsv(input: ArrayBuffer | Buffer | Uint8Array | string): ParsedRow[] {
  const text = toText(input);

  const result = Papa.parse<Record<string, any>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    delimiter: "", // auto-detect
  });

  if (result.errors?.length) {
    throw new Error(
      `CSV parsing failed: ${result.errors[0]?.message || "Unknown parse error"}. ` +
        `Tip: In Excel, try saving as "CSV UTF-8 (Comma delimited)".`
    );
  }

  const data = result.data || [];

  // Defensive: ensure headers exist and are not all empty
  const first = data[0] || {};
  const headers = Object.keys(first).map((h) => (h || "").trim()).filter(Boolean);

  if (!headers.length) {
    throw new Error(
      `Parsed CSV but headers are empty/invalid. ` +
        `This usually means encoding or delimiter issues. ` +
        `Try saving as "CSV UTF-8 (Comma delimited)" and re-upload.`
    );
  }

  // Remove BOM that might be attached to first header key
  // Example: "\ufeffTechnology" => "Technology"
  const bomHeader = Object.keys(first).find((k) => k && k.charCodeAt(0) === 0xfeff);
  if (bomHeader) {
    const cleanHeader = bomHeader.slice(1);
    for (const row of data) {
      if (row && Object.prototype.hasOwnProperty.call(row, bomHeader)) {
        (row as any)[cleanHeader] = (row as any)[bomHeader];
        delete (row as any)[bomHeader];
      }
    }
  }

  return data.map((row, idx) => ({
    rowIndex: idx + 1,
    data: row,
  }));
}
