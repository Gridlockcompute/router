import { config } from "../config.js";
import { tryPublicKey } from "../solana.js";
import { creditsToSol, lamportsToCredits, minDepositSol } from "./pricing.js";

export interface SolDepositInfo {
  rail: "sol";
  treasury_owner: string;
  deposit_address: string;
  lamports_per_credit: number;
  min_deposit_credits: number;
  min_deposit_sol: number;
  credit_unit: string;
  cluster: string;
}

export function buildSolDepositInfo(): SolDepositInfo | null {
  const treasury = tryPublicKey(config.treasury);
  if (!treasury) return null;

  return {
    rail: "sol",
    treasury_owner: treasury.toBase58(),
    deposit_address: treasury.toBase58(),
    lamports_per_credit: config.lamportsPerCredit,
    min_deposit_credits: config.minDepositLock,
    min_deposit_sol: minDepositSol(),
    credit_unit: "credits",
    cluster: config.solanaCluster,
  };
}

interface ParsedTxMeta {
  err: unknown;
  preBalances?: number[];
  postBalances?: number[];
}

interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      lamports?: number;
    };
  };
}

interface ParsedTxMessage {
  accountKeys?: Array<string | { pubkey: string; signer?: boolean }>;
  instructions?: ParsedInstruction[];
}

interface ParsedTxResult {
  meta?: ParsedTxMeta | null;
  transaction?: {
    message?: ParsedTxMessage;
  };
}

function accountKeyAt(
  keys: ParsedTxMessage["accountKeys"],
  index: number,
): string | null {
  const key = keys?.[index];
  if (!key) return null;
  return typeof key === "string" ? key : key.pubkey;
}

export async function verifySolDepositTransaction(
  txSignature: string,
  ownerWallet: string,
): Promise<{ credits: number; lamports: number; vault: string } | { error: string }> {
  const treasury = tryPublicKey(config.treasury);
  if (!treasury) {
    return { error: "Treasury not configured (TREASURY)" };
  }

  const owner = tryPublicKey(ownerWallet);
  if (!owner) return { error: "Invalid owner wallet" };

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

  const treasuryStr = treasury.toBase58();
  const ownerStr = owner.toBase58();
  const keys = tx.transaction?.message?.accountKeys ?? [];

  let treasuryCredit = 0;

  // Prefer explicit system transfers in parsed instructions.
  for (const ix of tx.transaction?.message?.instructions ?? []) {
    const parsed = ix.parsed;
    if (parsed?.type !== "transfer") continue;
    const info = parsed.info;
    if (!info?.source || !info.destination || info.lamports == null) continue;
    if (info.source === ownerStr && info.destination === treasuryStr) {
      treasuryCredit += info.lamports;
    }
  }

  // Fallback: balance deltas on treasury + owner accounts.
  if (treasuryCredit <= 0) {
    const pre = tx.meta.preBalances ?? [];
    const post = tx.meta.postBalances ?? [];
    for (let i = 0; i < Math.max(pre.length, post.length); i++) {
      const delta = (post[i] ?? 0) - (pre[i] ?? 0);
      const key = accountKeyAt(keys, i);
      if (!key || delta <= 0) continue;
      if (key === treasuryStr) treasuryCredit += delta;
    }
  }

  const lamports = treasuryCredit;
  if (lamports <= 0) {
    return { error: "No SOL transfer to treasury found in transaction" };
  }

  const credits = lamportsToCredits(BigInt(lamports));
  if (credits < config.minDepositLock) {
    return {
      error: `Deposit below minimum (${config.minDepositLock} credits / ${minDepositSol()} SOL)`,
    };
  }

  return { credits, lamports, vault: treasuryStr };
}
