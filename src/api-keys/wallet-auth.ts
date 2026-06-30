import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";

const MAX_AGE_MS = 5 * 60 * 1000;

export function buildWalletAuthMessage(
  action: string,
  wallet: string,
  timestampMs: number,
): string {
  return `gridlock:keys:${action}:${wallet}:${timestampMs}`;
}

export function verifyWalletSignature(params: {
  wallet: string;
  timestampMs: number;
  signatureBase64: string;
  message: string;
}): boolean {
  try {
    const pubkey = new PublicKey(params.wallet);
    const signature = Buffer.from(params.signatureBase64, "base64");
    const message = new TextEncoder().encode(params.message);
    if (signature.length !== 64) return false;
    return ed25519.verify(signature, message, pubkey.toBytes());
  } catch {
    return false;
  }
}

export function assertFreshTimestamp(timestampMs: number, now = Date.now()): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  const age = Math.abs(now - timestampMs);
  return age <= MAX_AGE_MS;
}

export function parseWalletAuthHeaders(headers: Headers): {
  wallet: string;
  timestampMs: number;
  signatureBase64: string;
} | null {
  const wallet = headers.get("x-gridlock-wallet")?.trim();
  const timestampRaw = headers.get("x-gridlock-timestamp")?.trim();
  const signatureBase64 = headers.get("x-gridlock-signature")?.trim();
  if (!wallet || !timestampRaw || !signatureBase64) return null;
  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs)) return null;
  return { wallet, timestampMs, signatureBase64 };
}

export function verifyWalletAuthRequest(
  action: string | readonly string[],
  headers: Headers,
): { wallet: string } | { error: string } {
  const parsed = parseWalletAuthHeaders(headers);
  if (!parsed) {
    return { error: "Missing X-Gridlock-Wallet, X-Gridlock-Timestamp, or X-Gridlock-Signature" };
  }
  if (!assertFreshTimestamp(parsed.timestampMs)) {
    return { error: "Request timestamp expired or invalid" };
  }
  try {
    new PublicKey(parsed.wallet);
  } catch {
    return { error: "Invalid wallet address" };
  }
  const actions = typeof action === "string" ? [action] : action;
  for (const a of actions) {
    const message = buildWalletAuthMessage(a, parsed.wallet, parsed.timestampMs);
    if (verifyWalletSignature({ ...parsed, message })) {
      return { wallet: parsed.wallet };
    }
  }
  return { error: "Invalid wallet signature" };
}
