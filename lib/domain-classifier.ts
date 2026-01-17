// FILE: lib/domain-classifier.ts

function s(v: any) {
  return (v ?? "").toString().toLowerCase().trim();
}

export function stabilizeDomain(input: {
  canonical_name: string;
  canonical_vendor?: string;
  current_domain?: string;
}): string {
  const name = s(input.canonical_name);
  const vendor = s(input.canonical_vendor);
  const current = (input.current_domain ?? "").toString().trim();

  // 1) Database always wins
  if (
    name.includes("sql server") ||
    name.includes("mssql") ||
    name.includes("microsoft sql") ||
    name.includes("postgres") ||
    name.includes("postgresql") ||
    name.includes("mysql") ||
    name.includes("mariadb") ||
    name.includes("oracle database") ||
    name.includes("mongodb") ||
    name.includes("cassandra") ||
    name.includes("redis")
  ) {
    return "database";
  }

  // 2) OS
  if (
    name.includes("windows") ||
    name.includes("linux") ||
    name.includes("ubuntu") ||
    name.includes("red hat") ||
    name.includes("rhel") ||
    name.includes("centos") ||
    name.includes("debian") ||
    name.includes("macos")
  ) {
    return "os";
  }

  // 3) Web servers
  if (
    name.includes("nginx") ||
    name.includes("apache http") ||
    name.includes("httpd") ||
    name.includes("iis") ||
    name.includes("tomcat") // tomcat can be middleware, but webserver is acceptable for beginner output
  ) {
    return "webserver";
  }

  // 4) Containers
  if (name.includes("docker") || name.includes("containerd") || name.includes("kubernetes") || name.includes("openshift")) {
    return "container";
  }

  // 5) Programming languages
  if (name === "python" || name.startsWith("python ") || name === "java" || name === "go" || name === "golang" || name === "ruby") {
    return "programming";
  }

  // 6) Runtime/framework
  if (
    name.includes(".net") ||
    name.includes("dotnet") ||
    name.includes("asp.net") ||
    name.includes("java runtime") ||
    name.includes("jre") ||
    name.includes("jdk") ||
    name.includes("node.js") ||
    name.includes("nodejs")
  ) {
    return "runtime/framework";
  }

  // If unknown, keep AI-selected domain if present
  return current;
}
