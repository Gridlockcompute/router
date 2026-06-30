import type { Context } from "hono";
import { config } from "../config.js";
import { verifyWalletAuthRequest } from "./wallet-auth.js";
import { walletFromSessionRequest } from "./wallet-session.js";

export function resolveWallet(
  c: Context,
  action: string | readonly string[],
): { wallet: string } | { error: string } {
  if (config.insecureKeyManagement) {
    const wallet = c.req.header("x-gridlock-wallet")?.trim();
    if (!wallet) {
      return { error: "Missing X-Gridlock-Wallet (insecure dev mode)" };
    }
    return { wallet };
  }
  const verified = verifyWalletAuthRequest(action, c.req.raw.headers);
  if ("error" in verified) return verified;
  return verified;
}

/** Read endpoints: accept a prior wallet session token OR a fresh signature. */
export function resolveWalletRead(
  c: Context,
  signatureActions: string | readonly string[],
): { wallet: string } | { error: string } {
  if (config.insecureKeyManagement) {
    return resolveWallet(c, signatureActions);
  }
  const sessionWallet = walletFromSessionRequest(c);
  if (sessionWallet) return { wallet: sessionWallet };
  return resolveWallet(c, signatureActions);
}
