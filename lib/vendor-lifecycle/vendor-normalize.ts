// FILE: lib/vendor-lifecycle/vendor-normalize.ts

function clean(v: any) {
    return (v ?? "").toString().trim();
  }
  
  function norm(v: string) {
    return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  
  /**
   * Canonicalize vendors to a stable set.
   * You can expand this list any time without changing other code.
   */
  const VENDOR_CANON: Record<string, string> = {
    "ab initio software": "AB Initio Software",
    "ab initio": "AB Initio Software",
  
    accenture: "Accenture",
    adobe: "Adobe",
    amazon: "Amazon",
    "amazon web services": "Amazon",
    aws: "Amazon",
  
    apple: "Apple",
    atlassian: "Atlassian",
    avaya: "Avaya",
    "bmc software": "BMC software",
    bmc: "BMC software",
  
    broadcom: "Broadcom",
    cisco: "Cisco",
    citrix: "Citrix",
    dell: "Dell",
    "f5 networks": "F5 networks",
    f5: "F5 networks",
  
    fujitsu: "Fujitsu",
    github: "GitHub",
    google: "Google",
    hp: "HP",
    "hewlett packard": "HP",
    "hewlett packard enterprise": "HP",
  
    informatica: "Informatica",
    ibm: "IBM",
    mcafee: "Mcafee",
    "micro focus": "Microfocus",
    microfocus: "Microfocus",
  
    netapp: "Netapp",
    microsoft: "Microsoft",
    msft: "Microsoft",
  
    "nice ltd": "nice ltd",
    "open source": "opensource",
    opensource: "opensource",
  
    "open text corp": "open text corp",
    optext: "open text corp",
    opentext: "open text corp",
  
    oracle: "Oracle",
    "palo alto networks": "palo alto networks",
    "palo alto": "palo alto networks",
  
    "pega systems": "pega systems",
    pega: "pega systems",
  
    "quest software": "Quest software",
    quest: "Quest software",
  
    redhat: "redhat",
    "red hat": "redhat",
  
    salesforce: "salesforce",
    sap: "SAP",
    "sas institute": "SAS Institute",
  
    servicenow: "ServicenOw",
    "service now": "ServicenOw",
  
    sybase: "sybase",
    vmware: "VMware",
  };
  
  export function normalizeVendorName(vendor: string): string {
    const key = norm(vendor);
    if (!key) return "";
    return VENDOR_CANON[key] || vendor.trim();
  }
  
  export function vendorKey(vendor: string): string {
    // stable lookup key
    return norm(normalizeVendorName(vendor));
  }
  