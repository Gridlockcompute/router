import { config } from "../config.js";
import {
  dbGetPendingUnstakeForWallet,
  dbInsertUnstakeRequest,
  dbMarkUnstakeClaimed,
} from "../db.js";
import { buildStakePosition, readLockTokenBalance } from "./reads.js";

export interface PendingUnstake {
  id: string;
  amount_lock: number;
  requested_at: string;
  unlock_at: string;
  claimable: boolean;
}

export async function getPendingUnstake(wallet: string): Promise<PendingUnstake | null> {
  const row = await dbGetPendingUnstakeForWallet(wallet);
  if (!row) return null;
  const unlockMs = new Date(row.unlock_at).getTime();
  return {
    id: row.id,
    amount_lock: row.amount_lock,
    requested_at: row.requested_at,
    unlock_at: row.unlock_at,
    claimable: Date.now() >= unlockMs,
  };
}

export async function requestUnstake(
  wallet: string,
  amountLock: number,
): Promise<{ ok: true; unlock_at: string; pending: PendingUnstake } | { error: string }> {
  if (!config.stakingEnabled || !config.lockMint) {
    return { error: "Staking is not enabled" };
  }
  if (amountLock < config.minStakeLock) {
    return { error: `Minimum unstake is ${config.minStakeLock} $LOCK` };
  }

  const existing = await dbGetPendingUnstakeForWallet(wallet);
  if (existing) {
    return { error: "An unstake request is already pending" };
  }

  const position = await buildStakePosition(wallet);
  const available = position.staked_lock - position.pending_unstake_lock;
  if (amountLock > available + 0.0001) {
    return { error: `Insufficient staked balance (${position.staked_lock} $LOCK available)` };
  }

  const unlockAt = new Date(Date.now() + config.stakeCooldownSec * 1000).toISOString();
  const inserted = await dbInsertUnstakeRequest(wallet, amountLock, unlockAt);
  if (!inserted) {
    return { error: "Failed to record unstake request" };
  }

  const pending = await getPendingUnstake(wallet);
  if (!pending) return { error: "Failed to load unstake request" };

  return { ok: true, unlock_at: unlockAt, pending };
}

export async function completeUnstakeClaim(
  wallet: string,
  claimTx: string,
): Promise<{ ok: true } | { error: string }> {
  const pending = await getPendingUnstake(wallet);
  if (!pending) return { error: "No pending unstake request" };
  if (!pending.claimable) {
    return { error: "Cooldown has not finished yet" };
  }

  const vaultAta = (await buildStakePosition(wallet)).staker_vault_ata;
  if (!vaultAta) return { error: "Staker vault not configured" };

  const before = await readLockTokenBalance(vaultAta);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await readLockTokenBalance(vaultAta);

  const withdrawn = before.balance_lock - after.balance_lock;
  if (withdrawn + 0.0001 < pending.amount_lock) {
    return {
      error: config.stakingClaimEnabled
        ? "Claim transaction did not withdraw the expected $LOCK from your staker vault"
        : "On-chain claim requires FeeCollector program upgrade (GRIDLOCK_STAKING_CLAIM_ENABLED)",
    };
  }

  const marked = await dbMarkUnstakeClaimed(pending.id, claimTx);
  if (!marked) return { error: "Failed to update unstake request" };
  return { ok: true };
}
