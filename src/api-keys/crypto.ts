import { createHash, randomBytes } from "node:crypto";

export type ApiKeyKind = "prod" | "dev";

const SLA_TIERS = new Set(["realtime", "standard", "batch", "confidential"]);

export function isValidSlaTier(tier: string): boolean {
  return SLA_TIERS.has(tier);
}

/** SHA-256 hex digest of the full API key secret. */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Generate a new API key secret and display prefix. */
export function generateApiKeySecret(kind: ApiKeyKind = "prod"): {
  secret: string;
  prefix: string;
  hash: string;
} {
  const token = randomBytes(24).toString("base64url");
  const secret = `gk-${kind}-${token}`;
  const prefix = `${secret.slice(0, 12)}…`;
  return { secret, prefix, hash: hashApiKey(secret) };
}

export function maskApiKeySecret(secret: string): string {
  if (secret.length <= 12) return secret;
  return `${secret.slice(0, 12)}…`;
}
