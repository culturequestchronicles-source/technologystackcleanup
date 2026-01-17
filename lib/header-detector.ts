// FILE: lib/header-detector.ts

export type HeaderMapping = {
  technologyKey: string;
  vendorKey: string;
  versionKey: string;
  endOfSupportKey: string;
  endOfLifeKey: string;
  confidence: {
    technology: number;
    vendor: number;
    version: number;
    endOfSupport: number;
    endOfLife: number;
  };
  explanation: string[];
};

function scoreHeader(h: string, variants: string[]) {
  const s = h.trim().toLowerCase();
  let score = 0;
  for (const v of variants) {
    const vv = v.toLowerCase();
    if (s === vv) score += 5;
    else if (s.replace(/[\s_\-()]/g, "") === vv.replace(/[\s_\-()]/g, "")) score += 4;
    else if (s.includes(vv)) score += 2;
  }
  return score;
}

export function detectHeaders(headers: string[]): HeaderMapping {
  const techVariants = [
    "technology",
    "technology name",
    "technologyname",
    "product",
    "product name",
    "productname",
    "application",
    "component",
    "software",
    "name",
  ];

  const vendorVariants = [
    "vendor",
    "vendor name",
    "vendorname",
    "supplier",
    "supplier name",
    "suppliername",
    "publisher",
    "manufacturer",
    "maker",
    "provider",
    "company",
  ];

  const versionVariants = [
    "version",
    "technology version",
    "technologyversion",
    "techversion",
    "product version",
    "release",
    "build",
  ];

  // End of Support (EOS) synonyms
  const eosVariants = [
    "end of support",
    "eos",
    "support end",
    "support end date",
    "end support",
    "end_support",
    "end of maintenance",
    "maintenance end",
  ];

  // End of Life (EOL) synonyms
  const eolVariants = [
    "end of life",
    "eol",
    "eol date",
    "endoflife",
    "end_of_life",
    "end-of-life",
    "retirement date",
    "sunset date",
  ];

  let bestTech = { key: "", score: 0 };
  let bestVendor = { key: "", score: 0 };
  let bestVersion = { key: "", score: 0 };
  let bestEos = { key: "", score: 0 };
  let bestEol = { key: "", score: 0 };

  for (const h of headers) {
    const t = scoreHeader(h, techVariants);
    const v = scoreHeader(h, vendorVariants);
    const ver = scoreHeader(h, versionVariants);
    const eos = scoreHeader(h, eosVariants);
    const eol = scoreHeader(h, eolVariants);

    if (t > bestTech.score) bestTech = { key: h, score: t };
    if (v > bestVendor.score) bestVendor = { key: h, score: v };
    if (ver > bestVersion.score) bestVersion = { key: h, score: ver };
    if (eos > bestEos.score) bestEos = { key: h, score: eos };
    if (eol > bestEol.score) bestEol = { key: h, score: eol };
  }

  const technologyKey = bestTech.key || "";
  const vendorKey = bestVendor.key || "";
  const versionKey = bestVersion.key || "";
  const endOfSupportKey = bestEos.key || "";
  const endOfLifeKey = bestEol.key || "";

  const explanation: string[] = [];
  explanation.push(`Detected technology column: "${technologyKey}" (score=${bestTech.score})`);
  explanation.push(`Detected vendor column: "${vendorKey}" (score=${bestVendor.score})`);
  explanation.push(`Detected version column: "${versionKey}" (score=${bestVersion.score})`);
  explanation.push(`Detected end-of-support column: "${endOfSupportKey}" (score=${bestEos.score})`);
  explanation.push(`Detected end-of-life column: "${endOfLifeKey}" (score=${bestEol.score})`);

  const confidence = {
    technology: Math.min(1, bestTech.score / 5),
    vendor: Math.min(1, bestVendor.score / 5),
    version: Math.min(1, bestVersion.score / 5),
    endOfSupport: Math.min(1, bestEos.score / 5),
    endOfLife: Math.min(1, bestEol.score / 5),
  };

  return {
    technologyKey,
    vendorKey,
    versionKey,
    endOfSupportKey,
    endOfLifeKey,
    confidence,
    explanation,
  };
}
