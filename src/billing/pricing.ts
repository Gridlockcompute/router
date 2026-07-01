import { config } from "../config.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Convert confirmed SOL lamports to billing credits (same numeric scale as computeFee). */
export function lamportsToCredits(lamports: bigint): number {
  if (lamports <= 0n || config.lamportsPerCredit <= 0) return 0;
  const credits = Number(lamports) / config.lamportsPerCredit;
  return Math.floor(credits * 10000) / 10000;
}

export function creditsToSol(credits: number): number {
  if (credits <= 0 || config.lamportsPerCredit <= 0) return 0;
  const lamports = credits * config.lamportsPerCredit;
  return Math.round((lamports / LAMPORTS_PER_SOL) * 1_000_000) / 1_000_000;
}

export function minDepositSol(): number {
  return creditsToSol(config.minDepositLock);
}

export function creditUnitLabel(): string {
  return config.billingRail === "sol" ? "credits" : "$LOCK";
}
