import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config, PROGRAM_IDS } from "../config.js";
import { jobsStore, totalLockBurned, workersRegistry } from "../state.js";
import { tryPublicKey } from "../solana.js";
import { dbGetPendingUnstakeForWallet } from "../db.js";
import {
  BURN_BPS,
  EPOCH_DAYS,
  LOCK_DECIMALS,
  STAKER_BPS,
  TARGET_APY_BPS,
  TREASURY_BPS,
  WORKER_BPS,
  estimatedDailyApyLock,
  multiplierForStake,
} from "./constants.js";

export function isStakingDepositEnabled(): boolean {
  return config.stakingEnabled && Boolean(config.lockMint);
}

function connection(): Connection {
  return new Connection(config.solanaRpcUrl, "confirmed");
}

export async function readLockTokenBalance(
  accountAddress: string,
): Promise<{ balance_lock: number; exists: boolean }> {
  const pubkey = tryPublicKey(accountAddress);
  if (!pubkey) return { balance_lock: 0, exists: false };
  try {
    const acct = await getAccount(connection(), pubkey, "confirmed", TOKEN_2022_PROGRAM_ID);
    return {
      balance_lock: Number(acct.amount) / 10 ** LOCK_DECIMALS,
      exists: true,
    };
  } catch {
    return { balance_lock: 0, exists: false };
  }
}

/** Planned Phase C vault: PDA authority + associated token account for passive stake. */
export function deriveStakerVaultAddresses(
  wallet: string,
): { authority: string; vault_ata: string } | null {
  const owner = tryPublicKey(wallet);
  const mint = tryPublicKey(config.lockMint);
  if (!owner || !mint) return null;

  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("staker_vault"), owner.toBuffer()],
    new PublicKey(PROGRAM_IDS.feeCollector),
  );
  const vaultAta = getAssociatedTokenAddressSync(mint, authority, true, TOKEN_2022_PROGRAM_ID);
  return {
    authority: authority.toBase58(),
    vault_ata: vaultAta.toBase58(),
  };
}

export async function buildStakeInfo() {
  const now = Date.now() / 1000;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const sinceTs = monthStart.getTime() / 1000;

  const penaltiesMtd = jobsStore
    .filter((j) => j.ts >= sinceTs)
    .reduce((sum, j) => sum + (j.penalty_paid ?? 0), 0);

  const [stakerPool, feeVault] = await Promise.all([
    config.stakerPool ? readLockTokenBalance(config.stakerPool) : Promise.resolve({ balance_lock: 0, exists: false }),
    config.feeVault ? readLockTokenBalance(config.feeVault) : Promise.resolve({ balance_lock: 0, exists: false }),
  ]);

  return {
    lock_mint: config.lockMint || null,
    staker_pool_address: config.stakerPool || null,
    staker_pool_lock: stakerPool.balance_lock,
    staker_pool_exists: stakerPool.exists,
    fee_vault_address: config.feeVault || null,
    fee_vault_lock: feeVault.balance_lock,
    fee_vault_exists: feeVault.exists,
    total_penalties_lock: Math.round(penaltiesMtd * 10000) / 10000,
    lock_burned: Math.round(totalLockBurned * 10000) / 10000,
    revenue_split: {
      stakers_pct: STAKER_BPS / 100,
      workers_pct: WORKER_BPS / 100,
      burn_pct: BURN_BPS / 100,
      treasury_pct: TREASURY_BPS / 100,
    },
    target_apy_pct: TARGET_APY_BPS / 100,
    epoch_days: EPOCH_DAYS,
    staking_deposit_enabled: isStakingDepositEnabled(),
    staking_claim_enabled: config.stakingClaimEnabled,
    unstake_cooldown_days: Math.round(config.stakeCooldownSec / 86400),
    min_stake_lock: config.minStakeLock,
    solana_cluster: config.solanaCluster,
    solana_settlement_enabled: config.solanaSettlementEnabled,
  };
}

export async function buildStakePosition(wallet: string) {
  const vault = deriveStakerVaultAddresses(wallet);
  const vaultBalance = vault
    ? await readLockTokenBalance(vault.vault_ata)
    : { balance_lock: 0, exists: false };

  const worker = workersRegistry.find((w) => w.address === wallet);
  const stakedLock = vaultBalance.balance_lock;
  const pendingRow = await dbGetPendingUnstakeForWallet(wallet);
  const pendingUnstake = pendingRow?.amount_lock ?? 0;
  const tier = multiplierForStake(stakedLock);

  return {
    wallet,
    staked_lock: stakedLock,
    staker_vault_authority: vault?.authority ?? null,
    staker_vault_ata: vault?.vault_ata ?? null,
    staker_vault_exists: vaultBalance.exists,
    pending_unstake_lock: pendingUnstake,
    pending_unstake: pendingRow
      ? {
          id: pendingRow.id,
          amount_lock: pendingRow.amount_lock,
          requested_at: pendingRow.requested_at,
          unlock_at: pendingRow.unlock_at,
          claimable: Date.now() >= new Date(pendingRow.unlock_at).getTime(),
        }
      : null,
    multiplier_tier: {
      label: tier.label,
      mult: tier.mult,
      min_lock: tier.min,
      max_lock: tier.max,
    },
    estimated_daily_apy_lock: estimatedDailyApyLock(stakedLock),
    worker: worker
      ? {
          registered: true,
          staked_lock: worker.staked_lock,
          role: worker.role,
          status: worker.status,
          sla_pass_rate: worker.sla_pass_rate,
        }
      : { registered: false },
    staking_deposit_enabled: isStakingDepositEnabled(),
    staking_claim_enabled: config.stakingClaimEnabled,
  };
}
