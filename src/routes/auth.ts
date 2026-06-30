import { Hono } from "hono";
import { resolveWallet } from "../api-keys/resolve-wallet.js";
import { createWalletSessionToken } from "../api-keys/wallet-session.js";

export const authRoutes = new Hono();

authRoutes.post("/v1/auth/session", async (c) => {
  const auth = resolveWallet(c, "session");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const session = createWalletSessionToken(auth.wallet);
  return c.json({
    token: session.token,
    expires_at: session.expires_at,
    wallet: auth.wallet,
  });
});
