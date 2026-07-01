import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { config } from "../config.js";
import { tryPublicKey } from "../solana.js";
import { LOCK_DECIMALS } from "./constants.js";
import { deriveStakerVaultAddresses } from "./reads.js";
import { buildPumpStakeAddresses } from "./pump-staking.js";

export function lockBaseUnitsToAmount(baseUnits: bigint, decimals = LOCK_DECIMALS): number {
  return Math.round((Number(baseUnits) / 10 ** decimals) * 10000) / 10000;
}

export interface StakeDepositInfo {
  staking_rail: "pump" | "lock";
  lock_mint: string;
  stake_mint: string;
  token_symbol: string;
  staker_vault_authority: string;
  staker_vault_ata: string;
  customer_ata: string;
  staking_program_id?: string;
  decimals: number;
  min_stake_lock: number;
  cooldown_days: number;
  instant_unstake: boolean;
  cluster: string;
}

export function buildStakeDepositInfo(ownerWallet: string): StakeDepositInfo | null {
  if (config.stakingRail === "pump") {
    const addrs = buildPumpStakeAddresses(ownerWallet);
    if (!addrs) return null;
    return {
      staking_rail: "pump",
      lock_mint: addrs.stake_mint,
      stake_mint: addrs.stake_mint,
      token_symbol: addrs.token_symbol,
      staker_vault_authority: addrs.stake_authority,
      staker_vault_ata: addrs.stake_vault_ata,
      customer_ata: addrs.owner_ata,
      staking_program_id: addrs.staking_program_id,
      decimals: addrs.token_decimals,
      min_stake_lock: config.minStakeLock,
      cooldown_days: 0,
      instant_unstake: true,
      cluster: config.solanaCluster,
    };
  }

  const vault = deriveStakerVaultAddresses(ownerWallet);
  const owner = tryPublicKey(ownerWallet);
  if (!vault || !owner || !config.lockMint) return null;

  try {
    const mint = new PublicKey(config.lockMint);
    const allowOffCurve = !PublicKey.isOnCurve(owner.toBuffer());
    const customerAta = getAssociatedTokenAddressSync(
      mint,
      owner,
      allowOffCurve,
      TOKEN_2022_PROGRAM_ID,
    );
    return {
      staking_rail: "lock",
      lock_mint: config.lockMint,
      stake_mint: config.lockMint,
      token_symbol: "LOCK",
      staker_vault_authority: vault.authority,
      staker_vault_ata: vault.vault_ata,
      customer_ata: customerAta.toBase58(),
      decimals: LOCK_DECIMALS,
      min_stake_lock: config.minStakeLock,
      cooldown_days: Math.round(config.stakeCooldownSec / 86400),
      instant_unstake: false,
      cluster: config.solanaCluster,
    };
  } catch {
    return null;
  }
}

interface ParsedTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount: string; decimals: number };
}

interface ParsedTxMeta {
  err: unknown;
  preTokenBalances?: ParsedTokenBalance[];
  postTokenBalances?: ParsedTokenBalance[];
}

interface ParsedTxResult {
  meta?: ParsedTxMeta | null;
}

export async function verifyStakeDepositTransaction(
  txSignature: string,
  ownerWallet: string,
): Promise<{ amountLock: number; vaultAta: string } | { error: string }> {
  const vault = deriveStakerVaultAddresses(ownerWallet);
  if (!vault || !config.lockMint) {
    return { error: "Staking not configured (LOCK_MINT)" };
  }

  const resp = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        txSignature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });

  const json = (await resp.json()) as { result?: ParsedTxResult | null; error?: { message?: string } };
  if (json.error) return { error: json.error.message ?? "RPC error" };

  const tx = json.result;
  if (!tx?.meta) return { error: "Transaction not found or not confirmed" };
  if (tx.meta.err) return { error: "Transaction failed on-chain" };

  const mint = config.lockMint;
  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();

  for (const bal of tx.meta.preTokenBalances ?? []) {
    if (bal.mint !== mint) continue;
    pre.set(`${bal.accountIndex}`, BigInt(bal.uiTokenAmount?.amount ?? "0"));
  }

  for (const bal of tx.meta.postTokenBalances ?? []) {
    if (bal.mint !== mint) continue;
    post.set(`${bal.accountIndex}`, BigInt(bal.uiTokenAmount?.amount ?? "0"));
  }

  let vaultCredit = 0n;
  let customerDebit = 0n;

  const allIndexes = new Set([...pre.keys(), ...post.keys()]);
  for (const idx of allIndexes) {
    const before = pre.get(idx) ?? 0n;
    const after = post.get(idx) ?? 0n;
    const delta = after - before;
    if (delta === 0n) continue;

    const row =
      (tx.meta.postTokenBalances ?? []).find((b) => `${b.accountIndex}` === idx)
      ?? (tx.meta.preTokenBalances ?? []).find((b) => `${b.accountIndex}` === idx);
    if (!row || row.mint !== mint) continue;

    if (row.owner === vault.authority && delta > 0n) {
      vaultCredit += delta;
    }
    if (row.owner === ownerWallet && delta < 0n) {
      customerDebit += -delta;
    }
  }

  const credited = vaultCredit > 0n ? vaultCredit : customerDebit;
  if (credited <= 0n) {
    return { error: "No $LOCK transfer to staker vault found in transaction" };
  }

  const amountLock = lockBaseUnitsToAmount(credited);
  if (amountLock < config.minStakeLock) {
    return { error: `Stake below minimum (${config.minStakeLock} $LOCK)` };
  }

  return { amountLock, vaultAta: vault.vault_ata };
}
