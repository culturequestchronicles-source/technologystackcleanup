type ParsedInput = {
    data: Record<string, any>;
  };
  
  export function extractTechnologyFields(input: ParsedInput) {
    const keys = Object.keys(input.data).map(k => k.toLowerCase());
  
    const find = (candidates: string[]) =>
      candidates.find(c => keys.includes(c));
  
    const techKey = find(["technology", "software", "product", "application"]);
    const versionKey = find(["version", "release"]);
    const vendorKey = find(["vendor", "publisher", "company"]);
  
    return {
      input_name: techKey ? input.data[techKey] : null,
      input_version: versionKey ? input.data[versionKey] : null,
      input_vendor: vendorKey ? input.data[vendorKey] : null,
      raw: input.data,
    };
  }
  