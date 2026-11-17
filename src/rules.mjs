import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_ALLOWLIST = fileURLToPath(new URL("../config/public-env-allowlist.json", import.meta.url));

export function loadRules(path = process.env.ALLOWLIST_PATH ?? DEFAULT_ALLOWLIST) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return {
    allowed: raw.allowed ?? {},
    deprecated: raw.deprecated ?? {},
    forbiddenNames: (raw.forbiddenNamePatterns ?? []).map((r) => ({ ...r, re: new RegExp(r.pattern, "i") })),
    forbiddenValues: (raw.forbiddenValuePatterns ?? []).map((r) => ({ ...r, re: new RegExp(r.pattern) })),
  };
}

/**
 * Classifies a NEXT_PUBLIC_ variable name.
 * Returns { status: "allowed" | "deprecated" | "forbidden" | "review", severity?, reason }.
 * The allowlist wins over the forbidden patterns, so a public-by-design name that happens to
 * contain TOKEN (e.g. a Mapbox public token) can be approved explicitly.
 */
export function classifyVar(name, rules) {
  if (name in rules.allowed) return { status: "allowed", reason: rules.allowed[name] };
  if (name in rules.deprecated) return { status: "deprecated", severity: "low", reason: rules.deprecated[name] };
  const rest = name.replace(/^NEXT_PUBLIC_/, "");
  const hit = rules.forbiddenNames.find((r) => r.re.test(rest));
  if (hit) return { status: "forbidden", severity: hit.severity, reason: hit.reason };
  return { status: "review", severity: "review", reason: "not on the approved list of public variables" };
}

/**
 * Says whether a value looks like a secret. The value is only inspected in memory and is never
 * returned, logged or stored: the result is a description such as "Anthropic API key".
 */
export function secretKindOfValue(value, rules) {
  const v = String(value).trim().replace(/^["']|["']$/g, "");
  if (!v) return null;
  const hit = rules.forbiddenValues.find((r) => r.re.test(v));
  if (hit) return hit.reason;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(v)) {
    try {
      const payload = JSON.parse(Buffer.from(v.split(".")[1], "base64url").toString("utf8"));
      if (payload.role === "service_role") return "Supabase service_role key (bypasses all RLS)";
    } catch {
      // not a JWT after all
    }
  }
  return null;
}
