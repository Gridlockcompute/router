export const STAKER_BPS = 6000;
export const WORKER_BPS = 2000;
export const BURN_BPS = 1000;
export const TREASURY_BPS = 1000;
export const TARGET_APY_BPS = 800;
export const EPOCH_DAYS = 7;
export const LOCK_DECIMALS = 9;

export const MULTIPLIER_TIERS = [
  { min: 0, max: 4999, mult: 1.0, label: "Base" },
  { min: 5000, max: 14999, mult: 1.5, label: "Bronze" },
  { min: 15000, max: 49999, mult: 2.0, label: "Silver" },
  { min: 50000, max: 999999, mult: 3.0, label: "Gold" },
] as const;

export function multiplierForStake(stakedLock: number): (typeof MULTIPLIER_TIERS)[number] {
  return (
    MULTIPLIER_TIERS.find((t) => stakedLock >= t.min && stakedLock <= t.max) ?? MULTIPLIER_TIERS[0]
  );
}

export function estimatedDailyApyLock(stakedLock: number): number {
  if (stakedLock <= 0) return 0;
  return Math.round(((stakedLock * TARGET_APY_BPS) / 10_000 / 365) * 10000) / 10000;
}
