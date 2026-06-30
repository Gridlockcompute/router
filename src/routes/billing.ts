import { Hono } from "hono";
import { resolveWallet, resolveWalletRead } from "../api-keys/resolve-wallet.js";
import {
  aggregateBilling,
  jobBelongsToWallet,
  mergeJobsById,
  monthStartTs,
} from "../billing/aggregate.js";
import { creditFromOnChainDeposit, getCreditBalance, topupCredits } from "../billing/credits.js";
import { buildDepositInfo, verifyDepositTransaction } from "../billing/deposits.js";
import { closeInvoicesForAllWallets, closeInvoicesForWallet } from "../billing/invoice-cron.js";
import { solscanTxUrl, syncInvoicesForWallet } from "../billing/invoices.js";
import { config } from "../config.js";
import {
  dbGetDepositByTx,
  dbInsertDeposit,
  dbListApiKeysByWallet,
  dbLoadJobsForWallet,
  supabaseConfigured,
} from "../db.js";
import { jobsStore } from "../state.js";

export const billingRoutes = new Hono();

const MAX_DEV_TOPUP = 500;

const BILLING_READ_ACTIONS = ["billing", "summary", "invoices", "deposit", "session"] as const;

billingRoutes.get("/v1/billing/summary", async (c) => {
  const auth = resolveWalletRead(c, BILLING_READ_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const sinceTs = monthStartTs();
  const memoryJobs = jobsStore.filter(
    (j) => jobBelongsToWallet(j, auth.wallet) && j.ts >= sinceTs,
  );
  const dbJobs = supabaseConfigured()
    ? await dbLoadJobsForWallet(auth.wallet, sinceTs)
    : [];
  const jobs = mergeJobsById(dbJobs, memoryJobs);

  const keys = supabaseConfigured() ? await dbListApiKeysByWallet(auth.wallet) : [];
  const keyNames = new Map(
    keys.map((k) => [k.id, { name: k.name, key_prefix: k.key_prefix }]),
  );

  const creditBalance = config.billingEnabled ? await getCreditBalance(auth.wallet) : null;
  const summary = aggregateBilling(jobs, auth.wallet, sinceTs, keyNames);
  summary.credit_balance_lock = creditBalance;

  return c.json(summary);
});

billingRoutes.get("/v1/billing/invoices", async (c) => {
  const auth = resolveWalletRead(c, BILLING_READ_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const invoices = await syncInvoicesForWallet(auth.wallet);
  return c.json({
    invoices: invoices.map((inv) => ({
      ...inv,
      explorer_url: inv.settlement_tx ? solscanTxUrl(inv.settlement_tx) : null,
    })),
    total: invoices.length,
    solana_cluster: config.solanaCluster,
  });
});

billingRoutes.post("/v1/billing/invoices/close", async (c) => {
  const auth = resolveWallet(c, "invoices");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const invoices = await closeInvoicesForWallet(auth.wallet);
  return c.json({ ok: true, invoices: invoices.length });
});

billingRoutes.post("/v1/billing/invoices/close-all", async (c) => {
  const secret = c.req.header("x-gridlock-cron-secret");
  if (!config.invoiceCronSecret || secret !== config.invoiceCronSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const count = await closeInvoicesForAllWallets();
  return c.json({ ok: true, wallets: count });
});

billingRoutes.get("/v1/billing/deposit/info", async (c) => {
  const auth = resolveWalletRead(c, BILLING_READ_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const info = buildDepositInfo(auth.wallet);
  if (!info) {
    return c.json({ error: "Deposit not configured (LOCK_MINT / TREASURY)" }, 503);
  }
  return c.json(info);
});

billingRoutes.post("/v1/billing/deposit/confirm", async (c) => {
  const auth = resolveWallet(c, "deposit");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const body = (await c.req.json()) as { tx_signature?: string };
  const txSignature = body.tx_signature?.trim();
  if (!txSignature) return c.json({ error: "tx_signature is required" }, 400);

  if (await dbGetDepositByTx(txSignature)) {
    return c.json({ error: "Deposit already credited", code: "duplicate_deposit" }, 409);
  }

  const verified = await verifyDepositTransaction(txSignature, auth.wallet);
  if ("error" in verified) {
    return c.json({ error: verified.error }, 400);
  }

  const inserted = await dbInsertDeposit({
    tx_signature: txSignature,
    owner_wallet: auth.wallet,
    amount_lock: verified.amountLock,
    deposit_vault: verified.vault,
  });
  if (!inserted) {
    return c.json({ error: "Deposit already credited", code: "duplicate_deposit" }, 409);
  }

  const balance = await creditFromOnChainDeposit(
    auth.wallet,
    verified.amountLock,
    txSignature,
  );

  return c.json({
    ok: true,
    credited: verified.amountLock,
    balance_lock: balance,
    explorer_url: solscanTxUrl(txSignature),
  });
});

billingRoutes.post("/v1/billing/topup", async (c) => {
  if (!config.billingDevTopup && !config.insecureKeyManagement) {
    return c.json({ error: "Top-up is disabled in production" }, 403);
  }

  const auth = resolveWallet(c, "topup");
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const body = (await c.req.json()) as { amount?: number };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: "amount must be a positive number" }, 400);
  }
  if (amount > MAX_DEV_TOPUP) {
    return c.json({ error: `amount exceeds dev limit (${MAX_DEV_TOPUP} $LOCK)` }, 400);
  }

  const balance = await topupCredits(auth.wallet, amount);
  return c.json({
    ok: true,
    credited: Math.round(amount * 10000) / 10000,
    balance_lock: balance,
  });
});
