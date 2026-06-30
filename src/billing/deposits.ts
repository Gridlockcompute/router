import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { config } from "../config.js";
import { tryPublicKey } from "../solana.js";

const LOCK_DECIMALS = 9;

export function getBillingDepositVault(): PublicKey | null {
  if (config.billingDepositVault) {
    return tryPublicKey(config.billingDepositVault);
  }
  if (!config.lockMint || !config.treasury) return null;
  try {
    const mint = new PublicKey(config.lockMint);
    const treasuryOwner = new PublicKey(config.treasury);
    return getAssociatedTokenAddressSync(
      mint,
      treasuryOwner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  } catch {
    return null;
  }
}

export function getCustomerLockAta(ownerWallet: string): PublicKey | null {
  const owner = tryPublicKey(ownerWallet);
  if (!owner || !config.lockMint) return null;
  try {
    const mint = new PublicKey(config.lockMint);
    return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  } catch {
    return null;
  }
}

export function lockBaseUnitsToAmount(baseUnits: bigint): number {
  return Math.round((Number(baseUnits) / 10 ** LOCK_DECIMALS) * 10000) / 10000;
}

export interface DepositInfo {
  lock_mint: string;
  deposit_vault: string;
  treasury_owner: string;
  customer_ata: string;
  decimals: number;
  min_deposit_lock: number;
  cluster: string;
}

export function buildDepositInfo(ownerWallet: string): DepositInfo | null {
  const vault = getBillingDepositVault();
  const customerAta = getCustomerLockAta(ownerWallet);
  if (!vault || !customerAta || !config.lockMint || !config.treasury) return null;

  return {
    lock_mint: config.lockMint,
    deposit_vault: vault.toBase58(),
    treasury_owner: config.treasury,
    customer_ata: customerAta.toBase58(),
    decimals: LOCK_DECIMALS,
    min_deposit_lock: config.minDepositLock,
    cluster: config.solanaCluster,
  };
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

export async function verifyDepositTransaction(
  txSignature: string,
  ownerWallet: string,
): Promise<{ amountLock: number; vault: string } | { error: string }> {
  const vault = getBillingDepositVault();
  if (!vault || !config.lockMint) {
    return { error: "Deposit vault not configured (LOCK_MINT / TREASURY)" };
  }

  const customerAta = getCustomerLockAta(ownerWallet);
  if (!customerAta) return { error: "Invalid owner wallet" };

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

    if (row.owner === config.treasury && delta > 0n) {
      vaultCredit += delta;
    }
    if (row.owner === ownerWallet && delta < 0n) {
      customerDebit += -delta;
    }
  }

  const credited = vaultCredit > 0n ? vaultCredit : customerDebit;
  if (credited <= 0n) {
    return { error: "No $LOCK transfer to treasury found in transaction" };
  }

  const amountLock = lockBaseUnitsToAmount(credited);
  if (amountLock < config.minDepositLock) {
    return { error: `Deposit below minimum (${config.minDepositLock} $LOCK)` };
  }

  return { amountLock, vault: vault.toBase58() };
}
