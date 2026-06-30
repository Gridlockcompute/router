import { Hono } from "hono";
import { PublicKey } from "@solana/web3.js";
import { resolveWallet, resolveWalletRead } from "../api-keys/resolve-wallet.js";
import { solscanTxUrl } from "../billing/invoices.js";
import {
  dbGetStakeDepositByTx,
  dbInsertStakeDeposit,
} from "../db.js";
import { config } from "../config.js";
import { solanaRpc } from "../solana.js";
import { buildStakeDepositInfo, verifyStakeDepositTransaction } from "../staking/deposit.js";
import { buildStakeInfo, buildStakePosition } from "../staking/reads.js";
import { buildClaimUnstakeTransaction } from "../staking/transactions.js";
import { completeUnstakeClaim, getPendingUnstake, requestUnstake } from "../staking/unstake.js";

export const stakeRoutes = new Hono();

const STAKE_READ_ACTIONS = ["stake", "session"] as const;
const STAKE_WRITE_ACTIONS = ["stake"] as const;

stakeRoutes.get("/v1/stake/info", async (c) => {
  const info = await buildStakeInfo();
  return c.json(info);
});

/** Read-only — stake balances are public on-chain; wallet query avoids a signature prompt. */
stakeRoutes.get("/v1/stake/position", async (c) => {
  const walletQuery = c.req.query("wallet")?.trim();
  if (walletQuery) {
    try {
      new PublicKey(walletQuery);
    } catch {
      return c.json({ error: "Invalid wallet address" }, 400);
    }
    const position = await buildStakePosition(walletQuery);
    return c.json(position);
  }

  const auth = resolveWalletRead(c, STAKE_READ_ACTIONS);
  if ("error" in auth) {
    return c.json({ error: "wallet query parameter is required" }, 400);
  }

  const position = await buildStakePosition(auth.wallet);
  return c.json(position);
});

stakeRoutes.get("/v1/stake/deposit/info", async (c) => {
  const walletQuery = c.req.query("wallet")?.trim();
  if (walletQuery) {
    try {
      new PublicKey(walletQuery);
    } catch {
      return c.json({ error: "Invalid wallet address" }, 400);
    }
    const info = buildStakeDepositInfo(walletQuery);
    if (!info) return c.json({ error: "Staking not configured (LOCK_MINT)" }, 503);
    return c.json(info);
  }

  const auth = resolveWalletRead(c, STAKE_READ_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const info = buildStakeDepositInfo(auth.wallet);
  if (!info) return c.json({ error: "Staking not configured (LOCK_MINT)" }, 503);
  return c.json(info);
});

stakeRoutes.post("/v1/stake/deposit/confirm", async (c) => {
  const auth = resolveWallet(c, STAKE_WRITE_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const body = (await c.req.json()) as { tx_signature?: string };
  const txSignature = body.tx_signature?.trim();
  if (!txSignature) return c.json({ error: "tx_signature is required" }, 400);

  if (await dbGetStakeDepositByTx(txSignature)) {
    return c.json({ error: "Stake deposit already recorded", code: "duplicate_deposit" }, 409);
  }

  const verified = await verifyStakeDepositTransaction(txSignature, auth.wallet);
  if ("error" in verified) {
    return c.json({ error: verified.error }, 400);
  }

  const inserted = await dbInsertStakeDeposit({
    tx_signature: txSignature,
    owner_wallet: auth.wallet,
    amount_lock: verified.amountLock,
    vault_ata: verified.vaultAta,
  });
  if (!inserted) {
    return c.json({ error: "Stake deposit already recorded", code: "duplicate_deposit" }, 409);
  }

  const position = await buildStakePosition(auth.wallet);

  return c.json({
    ok: true,
    staked_lock: verified.amountLock,
    total_staked_lock: position.staked_lock,
    explorer_url: solscanTxUrl(txSignature),
  });
});

stakeRoutes.post("/v1/stake/unstake/request", async (c) => {
  const auth = resolveWallet(c, STAKE_WRITE_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const body = (await c.req.json()) as { amount_lock?: number };
  const amountLock = Number(body.amount_lock);
  if (!Number.isFinite(amountLock) || amountLock <= 0) {
    return c.json({ error: "amount_lock must be a positive number" }, 400);
  }

  const result = await requestUnstake(auth.wallet, amountLock);
  if ("error" in result) return c.json({ error: result.error }, 400);

  return c.json({
    ok: true,
    unlock_at: result.unlock_at,
    pending: result.pending,
    cooldown_days: Math.round(config.stakeCooldownSec / 86400),
  });
});

stakeRoutes.get("/v1/stake/unstake/status", async (c) => {
  const walletQuery = c.req.query("wallet")?.trim();
  let wallet: string;
  if (walletQuery) {
    try {
      new PublicKey(walletQuery);
      wallet = walletQuery;
    } catch {
      return c.json({ error: "Invalid wallet address" }, 400);
    }
  } else {
    const auth = resolveWalletRead(c, STAKE_READ_ACTIONS);
    if ("error" in auth) return c.json({ error: auth.error }, 401);
    wallet = auth.wallet;
  }

  const pending = await getPendingUnstake(wallet);
  return c.json({
    pending,
    staking_claim_enabled: config.stakingClaimEnabled,
    cooldown_days: Math.round(config.stakeCooldownSec / 86400),
  });
});

/** Returns an unsigned claim transaction (base64) for the user to sign after cooldown. */
stakeRoutes.post("/v1/stake/unstake/claim-tx", async (c) => {
  const auth = resolveWallet(c, STAKE_WRITE_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  if (!config.stakingClaimEnabled) {
    return c.json(
      {
        error: "On-chain unstake claim requires FeeCollector program upgrade. Set GRIDLOCK_STAKING_CLAIM_ENABLED after redeploy.",
        code: "claim_not_enabled",
      },
      503,
    );
  }

  const pending = await getPendingUnstake(auth.wallet);
  if (!pending) return c.json({ error: "No pending unstake request" }, 400);
  if (!pending.claimable) return c.json({ error: "Cooldown has not finished yet" }, 400);

  const rpc = await solanaRpc<{ value: { blockhash: string } }>("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const blockhash = rpc.result?.value.blockhash;
  if (!blockhash) return c.json({ error: "Failed to fetch blockhash" }, 503);

  const tx = await buildClaimUnstakeTransaction(auth.wallet, blockhash);
  if (!tx) return c.json({ error: "Failed to build claim transaction" }, 503);

  return c.json({
    transaction_base64: Buffer.from(tx.serialize()).toString("base64"),
    amount_lock: pending.amount_lock,
  });
});

stakeRoutes.post("/v1/stake/unstake/confirm", async (c) => {
  const auth = resolveWallet(c, STAKE_WRITE_ACTIONS);
  if ("error" in auth) return c.json({ error: auth.error }, 401);

  const body = (await c.req.json()) as { tx_signature?: string };
  const txSignature = body.tx_signature?.trim();
  if (!txSignature) return c.json({ error: "tx_signature is required" }, 400);

  const result = await completeUnstakeClaim(auth.wallet, txSignature);
  if ("error" in result) return c.json({ error: result.error }, 400);

  const position = await buildStakePosition(auth.wallet);

  return c.json({
    ok: true,
    staked_lock: position.staked_lock,
    explorer_url: solscanTxUrl(txSignature),
  });
});
