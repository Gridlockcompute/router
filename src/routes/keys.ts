import { Hono } from "hono";
import { generateApiKeySecret, isValidSlaTier } from "../api-keys/crypto.js";
import { resolveWallet, resolveWalletRead } from "../api-keys/resolve-wallet.js";
import {
  dbGetApiKeyById,
  dbInsertApiKey,
  dbListApiKeysByWallet,
  dbRevokeApiKey,
  dbUpdateApiKey,
  supabaseConfigured,
  toPublicApiKey,
} from "../db.js";
import type { CreateApiKeyRequest, UpdateApiKeyRequest } from "../types.js";

export const keyRoutes = new Hono();

const KEYS_READ_ACTIONS = ["keys", "list", "session"] as const;

keyRoutes.get("/v1/keys", async (c) => {
  if (!supabaseConfigured()) {
    return c.json({ error: "API key storage not configured (Supabase required)" }, 503);
  }
  const auth = resolveWalletRead(c, KEYS_READ_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const keys = await dbListApiKeysByWallet(auth.wallet);
  return c.json({
    keys: keys.map(toPublicApiKey),
    total: keys.length,
  });
});

keyRoutes.post("/v1/keys", async (c) => {
  if (!supabaseConfigured()) {
    return c.json({ error: "API key storage not configured (Supabase required)" }, 503);
  }
  const auth = resolveWallet(c, "create");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const body = (await c.req.json()) as CreateApiKeyRequest;
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name is required" }, 400);

  const defaultSla = body.default_sla ?? "standard";
  if (!isValidSlaTier(defaultSla)) {
    return c.json({ error: "invalid default_sla" }, 400);
  }

  const kind = body.kind === "dev" ? "dev" : "prod";
  const { secret, prefix, hash } = generateApiKeySecret(kind);

  const record = await dbInsertApiKey({
    key_hash: hash,
    key_prefix: prefix,
    owner_wallet: auth.wallet,
    name,
    default_sla: defaultSla,
    tee_required: body.tee_required ?? false,
    allowed_ips: body.allowed_ips?.length ? body.allowed_ips : null,
  });

  if (!record) {
    return c.json({ error: "Failed to create API key" }, 500);
  }

  return c.json(
    {
      secret,
      key: toPublicApiKey(record),
      message: "Copy the secret now — it will not be shown again.",
    },
    201,
  );
});

keyRoutes.patch("/v1/keys/:id", async (c) => {
  if (!supabaseConfigured()) {
    return c.json({ error: "API key storage not configured (Supabase required)" }, 503);
  }
  const auth = resolveWallet(c, "update");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const id = c.req.param("id");
  const body = (await c.req.json()) as UpdateApiKeyRequest;
  const patch: UpdateApiKeyRequest = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ error: "name cannot be empty" }, 400);
    patch.name = name;
  }
  if (body.default_sla !== undefined) {
    if (!isValidSlaTier(body.default_sla)) {
      return c.json({ error: "invalid default_sla" }, 400);
    }
    patch.default_sla = body.default_sla;
  }
  if (body.tee_required !== undefined) patch.tee_required = body.tee_required;
  if (body.allowed_ips !== undefined) {
    patch.allowed_ips = body.allowed_ips?.length ? body.allowed_ips : null;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const updated = await dbUpdateApiKey(id, auth.wallet, patch);
  if (!updated) return c.json({ error: "API key not found" }, 404);
  return c.json({ key: toPublicApiKey(updated) });
});

keyRoutes.delete("/v1/keys/:id", async (c) => {
  if (!supabaseConfigured()) {
    return c.json({ error: "API key storage not configured (Supabase required)" }, 503);
  }
  const auth = resolveWallet(c, "revoke");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const id = c.req.param("id");
  const existing = await dbGetApiKeyById(id, auth.wallet);
  if (!existing) return c.json({ error: "API key not found" }, 404);

  const ok = await dbRevokeApiKey(id, auth.wallet);
  if (!ok) return c.json({ error: "Failed to revoke API key" }, 500);
  return c.json({ ok: true, id });
});
