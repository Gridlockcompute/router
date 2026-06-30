import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "../config.js";

const TOKEN_PREFIX = "gls1.";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function sessionSecret(): string {
  return config.walletSessionSecret;
}

function signPayload(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function createWalletSessionToken(wallet: string): { token: string; expires_at: number } {
  const expires_at = Date.now() + SESSION_TTL_MS;
  const payload = `${wallet}:${expires_at}`;
  const token = `${TOKEN_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}.${signPayload(payload)}`;
  return { token, expires_at };
}

export function verifyWalletSessionToken(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const rest = token.slice(TOKEN_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;

  const payloadB64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const expected = signPayload(payload);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const colon = payload.lastIndexOf(":");
  if (colon <= 0) return null;
  const wallet = payload.slice(0, colon);
  const expiresAt = Number(payload.slice(colon + 1));
  if (!wallet || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return wallet;
}

export function walletFromSessionRequest(c: Context): string | null {
  const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return verifyWalletSessionToken(token);
}
