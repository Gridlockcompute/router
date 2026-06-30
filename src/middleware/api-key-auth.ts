import type { Context, Next } from "hono";
import { config, OPEN_PATHS } from "../config.js";
import { dbGetApiKeyByHash, dbHasActiveApiKeys, supabaseConfigured } from "../db.js";
import { hashApiKey } from "../api-keys/crypto.js";
import type { ApiKeyContext } from "../types.js";

function bearerToken(c: Context): string {
  return (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function envKeyContext(token: string): ApiKeyContext {
  return {
    id: "env",
    owner_wallet: token.slice(0, 12),
    key_prefix: token.slice(0, 12) + "…",
    default_sla: "standard",
    tee_required: false,
    allowed_ips: null,
    source: "env",
  };
}

function isPublicReadPath(path: string): boolean {
  return (
    path === "/v1/workers"
    || path === "/v1/workers/register"
    || path === "/v1/workers/heartbeat"
    || path.startsWith("/v1/workers/")
    || path.startsWith("/v1/jobs")
    || path.startsWith("/v1/stats/")
    || path === "/v1/leaderboard"
    || path === "/v1/autoscale/signal"
  );
}

function isKeyManagementPath(path: string): boolean {
  return (
    path.startsWith("/v1/keys")
    || path.startsWith("/v1/billing")
    || path.startsWith("/v1/auth")
    || path.startsWith("/v1/stake")
  );
}

export async function authRequired(): Promise<boolean> {
  if (config.apiKeys.size > 0) return true;
  if (!supabaseConfigured()) return false;
  return dbHasActiveApiKeys();
}

export async function resolveApiKeyContext(token: string): Promise<ApiKeyContext | null> {
  if (!token) return null;
  if (config.apiKeys.has(token)) return envKeyContext(token);
  if (!supabaseConfigured()) return null;
  const row = await dbGetApiKeyByHash(hashApiKey(token));
  if (!row) return null;
  return {
    id: row.id,
    owner_wallet: row.owner_wallet,
    key_prefix: row.key_prefix,
    default_sla: row.default_sla,
    tee_required: row.tee_required,
    allowed_ips: row.allowed_ips,
    source: "database",
  };
}

export async function apiKeyAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const path = c.req.path;

  if (isKeyManagementPath(path) || isPublicReadPath(path)) {
    return next();
  }

  if (OPEN_PATHS.has(path)) {
    return next();
  }

  const requireAuth = await authRequired();
  if (!requireAuth) {
    return next();
  }

  const token = bearerToken(c);
  const ctx = await resolveApiKeyContext(token);
  if (!ctx) {
    return c.json({ error: "Invalid or missing API key" }, 401);
  }

  if (ctx.allowed_ips?.length) {
    const clientIp =
      c.req.header("cf-connecting-ip")
      ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip");
    if (!clientIp || !ctx.allowed_ips.includes(clientIp)) {
      return c.json({ error: "API key not allowed from this IP" }, 403);
    }
  }

  c.set("apiKey", ctx);
  return next();
}

export function getApiKeyContext(c: Context): ApiKeyContext | undefined {
  return c.get("apiKey");
}
