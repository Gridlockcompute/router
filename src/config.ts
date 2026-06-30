import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  vllmEndpoint: process.env.VLLM_ENDPOINT ?? "http://localhost:8000",
  vllmApiKey: process.env.VLLM_API_KEY ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  solanaRpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  /** Solana cluster for explorer links (devnet | mainnet-beta). */
  solanaCluster: process.env.SOLANA_CLUSTER ?? "devnet",
  routerKeypairPath: expandHome(process.env.ROUTER_KEYPAIR_PATH ?? "~/.config/solana/id.json"),
  /** Off by default — requires LOCK mint, token vaults, and matching Anchor ix encoding. */
  solanaSettlementEnabled: process.env.SOLANA_SETTLEMENT_ENABLED === "true",
  lockMint: process.env.LOCK_MINT ?? "",
  feeVault: process.env.FEE_VAULT ?? "",
  stakerPool: process.env.STAKER_POOL ?? "",
  workerPayout: process.env.WORKER_PAYOUT ?? "",
  treasury: process.env.TREASURY ?? "",
  burnVault: process.env.BURN_VAULT ?? "",
  /** Router LOCK ATA — pays open_job escrow (devnet: same wallet as payer). */
  customerWallet: process.env.CUSTOMER_WALLET ?? "",
  /** Default worker stake LOCK ATA for penalty transfers. */
  defaultWorkerStake: process.env.DEFAULT_WORKER_STAKE ?? "",
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseKey: process.env.SUPABASE_KEY ?? "",
  watcherSampleRate: Number(process.env.WATCHER_SAMPLE_RATE ?? "0.05"),
  /** Dev only: skip wallet signatures on /v1/keys (trust X-Gridlock-Wallet header). */
  insecureKeyManagement: process.env.GRIDLOCK_INSECURE_KEY_MANAGEMENT === "true",
  /** Deduct $LOCK credits for DB-owned API keys before serving inference. */
  billingEnabled: process.env.GRIDLOCK_BILLING_ENABLED !== "false",
  /** Credits granted when a wallet row is first created. */
  startingCreditLock: Number(process.env.GRIDLOCK_STARTING_CREDIT_LOCK ?? "10"),
  /** Dev: allow POST /v1/billing/topup to add test credits (wallet-signed). */
  billingDevTopup: process.env.GRIDLOCK_BILLING_DEV_TOPUP === "true",
  /** Treasury LOCK ATA override (defaults to ATA of TREASURY + LOCK_MINT). */
  billingDepositVault: process.env.BILLING_DEPOSIT_VAULT ?? "",
  minDepositLock: Number(process.env.GRIDLOCK_MIN_DEPOSIT_LOCK ?? "1"),
  /** Passive staking (Phase C). */
  stakingEnabled: process.env.GRIDLOCK_STAKING_ENABLED !== "false",
  minStakeLock: Number(process.env.GRIDLOCK_MIN_STAKE_LOCK ?? "1"),
  /** Unstake cooldown before claim (default 7 days; use 60 for dev). */
  stakeCooldownSec: Number(process.env.GRIDLOCK_STAKE_COOLDOWN_SEC ?? String(7 * 86400)),
  /** Set true after FeeCollector program is redeployed with claim_unstake. */
  stakingClaimEnabled: process.env.GRIDLOCK_STAKING_CLAIM_ENABLED === "true",
  /** Record API key owner on job escrow metadata for on-chain correlation. */
  perCustomerEscrowTracking: process.env.GRIDLOCK_PER_CUSTOMER_ESCROW !== "false",
  /** Optional secret for POST /v1/billing/invoices/close-all (external cron). */
  invoiceCronSecret: process.env.GRIDLOCK_INVOICE_CRON_SECRET ?? "",
  /** HMAC secret for wallet console session tokens (24h read access). */
  walletSessionSecret:
    process.env.GRIDLOCK_WALLET_SESSION_SECRET
    ?? process.env.SUPABASE_KEY
    ?? "gridlock-dev-wallet-session",
  apiKeys: new Set(
    (process.env.API_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  ),
};

export const OPEN_PATHS = new Set([
  "/health",
  "/v1/live",
  "/v1/ws",
  "/v1/capacity/tee",
  "/v1/network/stats",
  "/v1/models",
  "/v1/stake/info",
  "/v1/stake/position",
  "/v1/stake/deposit/info",
  "/v1/chat/completions",
]);

export const PROGRAM_IDS = {
  providerRegistry: "GvCMygAV4RNYVgPybMmgEb36AkSKEBQJJw45WfUfSfmu",
  jobScheduler: "14ZQ7ubKgrWJRhcuzjmUj733fStgwUpERWXMj6pKuYcT",
  slaRegistry: "5me7JG25p4NH1XCYtxWn9bU5sij8Xos1We5g47TbRxxM",
  slaEnforcer: "3H3yLvY7m7TaGkMSvvkvG9NQT5nDhVLNrZTfywiBaoLJ",
  feeCollector: "6GoaeiUQC8DaLXSDjd6CPACZZ1rM4xL4VCzxu1iC5xoU",
};

export const SLA_TARGETS: Record<string, { ttft: number; tpot: number }> = {
  realtime: { ttft: 300, tpot: 60 },
  standard: { ttft: 800, tpot: 120 },
  batch: { ttft: 5000, tpot: 9999 },
  confidential: { ttft: 800, tpot: 120 },
};

export const PENALTY_MULT: Record<string, number> = {
  realtime: 2.0,
  standard: 1.0,
  batch: 0.25,
  confidential: 1.0,
};

const MODEL_BASE_FEE: Record<string, number> = {
  "llama-3.1-70b": 0.08,
  "llama-3.1-8b": 0.02,
  "mistral-7b": 0.02,
  "qwen2.5-72b": 0.07,
};

const TIER_FEE_MULT: Record<string, number> = {
  realtime: 2.0,
  standard: 1.0,
  batch: 0.4,
  confidential: 2.5,
};

export function computeFee(model: string, slaTier: string, promptTokens: number): number {
  const base = MODEL_BASE_FEE[model] ?? 0.05;
  const tier = TIER_FEE_MULT[slaTier] ?? 1.0;
  const scale = Math.max(1.0, promptTokens / 512);
  return Math.round(base * tier * scale * 10000) / 10000;
}
