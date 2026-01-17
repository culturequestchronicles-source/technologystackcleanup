// FILE: lib/version-utils.ts

export type VersionParts = {
    major_version: string;        // e.g. "12.0" or "5.2"
    minor_version_build: string;  // e.g. "12.0.6024.0" or "5.2.x"
    service_pack: string;         // e.g. "SP3"
    version_notes: string;        // extra notes for audit/debug
  };
  
  function clean(s: string) {
    return (s || "").trim();
  }
  
  function findServicePack(text: string): string {
    const t = text.toUpperCase();
    const m = t.match(/\bSP\s*([0-9]{1,2})\b/);
    if (m) return `SP${m[1]}`;
    return "";
  }
  
  function extractNumericPrefix(version: string): string {
    // first numeric run like 12.0 or 5.2 or 3.1
    const m = version.match(/(\d+(?:\.\d+){0,3})/);
    return m ? m[1] : "";
  }
  
  export function deriveVersionParts(input: {
    technology: string;
    version: string;
  }): VersionParts {
    const technology = clean(input.technology);
    const version = clean(input.version);
  
    const sp = findServicePack(`${technology} ${version}`);
  
    // If no version, return blanks (still valid output)
    if (!version) {
      return {
        major_version: "",
        minor_version_build: "",
        service_pack: sp,
        version_notes: sp ? "Service pack found in product name." : "No version provided.",
      };
    }
  
    // Handle like "5.2.x" or "3.1.x"
    const hasX = /(^|\.)x\b/i.test(version) || /\bx\b/i.test(version);
  
    // First numeric prefix: 12.0.6024.0 or 5.2
    const numeric = extractNumericPrefix(version);
  
    // Major is usually first 2 segments if present: 12.0, 5.2, 3.1
    let major = "";
    if (numeric) {
      const parts = numeric.split(".");
      if (parts.length >= 2) major = `${parts[0]}.${parts[1]}`;
      else major = parts[0];
    }
  
    // Minor/build: keep full numeric if long, else keep original version (preserve .x)
    let minorBuild = "";
    if (numeric && numeric.split(".").length >= 3) {
      // 12.0.6024.0 style
      minorBuild = numeric;
    } else if (hasX) {
      minorBuild = version; // preserve "5.2.x"
    } else if (numeric) {
      minorBuild = numeric; // "5.2"
    } else {
      minorBuild = version; // fallback
    }
  
    const notes: string[] = [];
    if (sp) notes.push(`Detected ${sp}.`);
    if (!numeric) notes.push("No numeric version found; preserved raw version.");
    if (hasX) notes.push("Wildcard version detected (x).");
  
    return {
      major_version: major,
      minor_version_build: minorBuild,
      service_pack: sp,
      version_notes: notes.join(" ").trim(),
    };
  }
  