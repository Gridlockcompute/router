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
import { buildPumpStakeAddresses, derivePumpStakeVault } from "./pump-staking.js";
import { getWorkerBoostInfo } from "./worker-boost.js";

export function activeStakeMint(): string | null {
  if (config.stakingRail === "pump") return config.pumpTokenMint || null;
  return config.lockMint || null;
}

export function activeStakeDecimals(): number {
  if (config.stakingRail === "pump") return config.pumpTokenDecimals;
  return LOCK_DECIMALS;
}

export function isStakingDepositEnabled(): boolean {
  if (!config.stakingEnabled) return false;
  if (config.stakingRail === "pump") return Boolean(config.pumpTokenMint);
  return Boolean(config.lockMint);
}

function connection(): Connection {
  return new Connection(config.solanaRpcUrl, "confirmed");
}

export async function readTokenBalance(
  accountAddress: string,
  decimals = LOCK_DECIMALS,
): Promise<{ balance_lock: number; exists: boolean }> {
  const pubkey = tryPublicKey(accountAddress);
  if (!pubkey) return { balance_lock: 0, exists: false };
  try {
    const acct = await getAccount(connection(), pubkey, "confirmed", TOKEN_2022_PROGRAM_ID);
    return {
      balance_lock: Number(acct.amount) / 10 ** decimals,
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
    config.stakerPool ? readTokenBalance(config.stakerPool) : Promise.resolve({ balance_lock: 0, exists: false }),
    config.feeVault ? readTokenBalance(config.feeVault) : Promise.resolve({ balance_lock: 0, exists: false }),
  ]);

  return {
    staking_rail: config.stakingRail,
    stake_mint: activeStakeMint(),
    lock_mint: activeStakeMint(),
    token_symbol: config.stakingRail === "pump" ? config.pumpTokenSymbol : "LOCK",
    token_decimals: activeStakeDecimals(),
    staking_program_id: config.stakingRail === "pump" ? config.stakingProgramId : null,
    instant_unstake: config.stakingRail === "pump",
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
    staking_claim_enabled: config.stakingRail === "pump" ? true : config.stakingClaimEnabled,
    unstake_cooldown_days: config.stakingRail === "pump" ? 0 : Math.round(config.stakeCooldownSec / 86400),
    min_stake_lock: config.minStakeLock,
    solana_cluster: config.solanaCluster,
    solana_settlement_enabled: config.solanaSettlementEnabled,
  };
}

export async function buildStakePosition(wallet: string) {
  const decimals = activeStakeDecimals();
  let vault: { authority: string; vault_ata: string } | null = null;
  let vaultBalance = { balance_lock: 0, exists: false };

  if (config.stakingRail === "pump") {
    const pumpVault = derivePumpStakeVault(wallet);
    const addrs = buildPumpStakeAddresses(wallet);
    if (pumpVault && addrs) {
      vault = { authority: addrs.stake_authority, vault_ata: addrs.stake_vault_ata };
      vaultBalance = await readTokenBalance(pumpVault.toBase58(), decimals);
    }
  } else {
    vault = deriveStakerVaultAddresses(wallet);
    vaultBalance = vault
      ? await readTokenBalance(vault.vault_ata, decimals)
      : { balance_lock: 0, exists: false };
  }

  const worker = workersRegistry.find((w) => w.address === wallet);
  const stakedLock = vaultBalance.balance_lock;
  const pendingRow =
    config.stakingRail === "pump" ? null : await dbGetPendingUnstakeForWallet(wallet);
  const pendingUnstake = pendingRow?.amount_lock ?? 0;
  const tier = multiplierForStake(stakedLock);
  const workerBoost = await getWorkerBoostInfo(wallet);

  return {
    wallet,
    staking_rail: config.stakingRail,
    token_symbol: config.stakingRail === "pump" ? config.pumpTokenSymbol : "LOCK",
    token_decimals: decimals,
    instant_unstake: config.stakingRail === "pump",
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
    worker_boost: workerBoost,
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
    staking_claim_enabled: config.stakingRail === "pump" ? true : config.stakingClaimEnabled,
  };
}
