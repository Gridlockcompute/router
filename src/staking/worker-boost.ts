import { config } from "../config.js";
import { dbGetOldestStakeDepositAgeSec, supabaseConfigured } from "../db.js";
import { readTokenBalance } from "./reads.js";
import { derivePumpStakeVault } from "./pump-staking.js";
import { multiplierForStake, WORKER_BPS } from "./constants.js";

export interface WorkerBoostInfo {
  staked_grid: number;
  mature_for_boost: boolean;
  boost_active: boolean;
  base_share_bps: number;
  effective_share_bps: number;
  tier_label: string;
  tier_mult: number;
}

/** Mature GRID stake unlocks tier multiplier on worker fee share (base = WORKER_BPS). */
export async function getWorkerBoostInfo(wallet: string): Promise<WorkerBoostInfo> {
  const baseBps = WORKER_BPS;
  const empty: WorkerBoostInfo = {
    staked_grid: 0,
    mature_for_boost: false,
    boost_active: false,
    base_share_bps: baseBps,
    effective_share_bps: baseBps,
    tier_label: "Base",
    tier_mult: 1,
  };

  if (config.stakingRail !== "pump" || !config.pumpTokenMint) {
    return empty;
  }

  const vault = derivePumpStakeVault(wallet);
  if (!vault) return empty;

  const { balance_lock: staked } = await readTokenBalance(
    vault.toBase58(),
    config.pumpTokenDecimals,
  );
  if (staked <= 0) return { ...empty, staked_grid: 0 };

  let mature = false;
  if (config.workerStakeMatureSec <= 0) {
    mature = true;
  } else if (supabaseConfigured()) {
    const ageSec = await dbGetOldestStakeDepositAgeSec(wallet);
    mature = ageSec != null && ageSec >= config.workerStakeMatureSec;
  } else {
    mature = staked >= config.workerBoostMinStake;
  }

  const tier = multiplierForStake(staked);
  const boostActive = mature && staked >= config.workerBoostMinStake;
  const rawBps = boostActive ? Math.round(baseBps * tier.mult) : baseBps;
  const effectiveBps = Math.min(rawBps, config.workerMaxShareBps);

  return {
    staked_grid: staked,
    mature_for_boost: mature,
    boost_active: boostActive,
    base_share_bps: baseBps,
    effective_share_bps: effectiveBps,
    tier_label: tier.label,
    tier_mult: tier.mult,
  };
}

/** Worker share of job fee as a 0–1 fraction. */
export async function getWorkerRevenueShare(wallet: string): Promise<number> {
  const info = await getWorkerBoostInfo(wallet);
  return info.effective_share_bps / 10_000;
}
