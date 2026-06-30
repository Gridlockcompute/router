import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AccountMeta,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { config, PROGRAM_IDS } from "./config.js";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** True when `value` is a valid Solana base58 public key. */
export function isValidSolanaPubkey(value: string): boolean {
  if (!value || value.length < 32 || value.length > 44) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function tryPublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function borshString(value: string): Buffer {
  const enc = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(enc.length);
  return Buffer.concat([len, enc]);
}

function borshBool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

function borshU32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function borshU64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function loadKeypair(): Keypair | null {
  try {
    const raw = readFileSync(config.routerKeypairPath, "utf8");
    const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(bytes);
  } catch (error) {
    console.log(`[solana] keypair load failed: ${error}`);
    return null;
  }
}

function derivePda(programId: string, seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
}

export async function solanaRpc<T = unknown>(method: string, params: unknown[]): Promise<{ result?: T; error?: unknown }> {
  const resp = await fetch(config.solanaRpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3_000),
  });
  return resp.json() as Promise<{ result?: T; error?: unknown }>;
}

async function sendAnchorIx(programId: string, data: Buffer, accounts: AccountMeta[]): Promise<string | null> {
  if (!config.solanaRpcUrl || config.solanaRpcUrl.includes("localhost")) return null;
  try {
    const kp = loadKeypair();
    if (!kp) return null;

    const rpc = await solanaRpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const blockhash = rpc.result?.value.blockhash;
    if (!blockhash) return null;

    const ix = new TransactionInstruction({
      programId: new PublicKey(programId),
      keys: accounts,
      data,
    });

    const message = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([kp]);

    const result = await solanaRpc<string>("sendTransaction", [
      Buffer.from(tx.serialize()).toString("base64"),
      { encoding: "base64", preflightCommitment: "confirmed" },
    ]);

    if (result.error) {
      console.log(`[solana] tx error:`, result.error);
      return null;
    }
    console.log(`[solana] tx: ${result.result}`);
    return result.result ?? null;
  } catch (error) {
    console.log(`[solana] send failed: ${error}`);
    return null;
  }
}

function borshOptionBytes32(value: Buffer | null): Buffer {
  if (!value) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), value]);
}

/** Stable 32-byte job id for on-chain receipt PDAs (matches Anchor [u8; 32]). */
function jobIdBytes(jobId: string): Buffer {
  return createHash("sha256").update(jobId).digest();
}

export async function anchorCommitReceipt(
  jobId: string,
  slaTier: string,
  ttftMs: number,
  tpotMs: number,
  slaMet: boolean,
  confidential: boolean,
): Promise<string | null> {
  if (!config.solanaRpcUrl || config.solanaRpcUrl.includes("localhost")) return null;
  try {
    const kp = loadKeypair();
    if (!kp) return null;
    const id = jobIdBytes(jobId);
    const [pda] = derivePda(PROGRAM_IDS.slaRegistry, [Buffer.from("receipt"), id]);
    const data = Buffer.concat([
      anchorDiscriminator("commit_receipt"),
      id,
      borshString(slaTier),
      borshU32(ttftMs),
      borshU32(tpotMs),
      Buffer.alloc(64),
      borshBool(slaMet),
      borshBool(confidential),
      borshOptionBytes32(null),
    ]);
    return sendAnchorIx(PROGRAM_IDS.slaRegistry, data, [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  } catch (error) {
    console.log(`[solana] commit_receipt: ${error}`);
    return null;
  }
}

export async function anchorSettleOrPenalize(jobId: string): Promise<string | null> {
  if (!config.solanaRpcUrl || config.solanaRpcUrl.includes("localhost")) return null;
  try {
    const kp = loadKeypair();
    if (!kp) return null;
    const id = jobIdBytes(jobId);
    const [receipt] = derivePda(PROGRAM_IDS.slaRegistry, [Buffer.from("receipt"), id]);
    const [enforcer] = derivePda(PROGRAM_IDS.slaEnforcer, [Buffer.from("sla_enforcer")]);
    const data = Buffer.concat([anchorDiscriminator("settle_or_penalize"), id]);
    return sendAnchorIx(PROGRAM_IDS.slaEnforcer, data, [
      { pubkey: enforcer, isSigner: false, isWritable: false },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ]);
  } catch (error) {
    console.log(`[solana] settle_or_penalize: ${error}`);
    return null;
  }
}

export async function anchorDistributeFees(_jobId: string, amountLock: number): Promise<string | null> {
  if (!config.solanaRpcUrl || config.solanaRpcUrl.includes("localhost")) return null;
  const { lockMint, feeVault, stakerPool, workerPayout, treasury, burnVault } = config;
  if (!lockMint || !feeVault || !stakerPool || !workerPayout || !treasury || !burnVault) {
    console.log("[solana] distribute_fees: LOCK mint / vault env vars not configured");
    return null;
  }
  try {
    const [collector] = derivePda(PROGRAM_IDS.feeCollector, [Buffer.from("fee_collector")]);
    const data = Buffer.concat([anchorDiscriminator("distribute_fees"), borshU64(amountLock)]);
    return sendAnchorIx(PROGRAM_IDS.feeCollector, data, [
      { pubkey: collector, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(feeVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(stakerPool), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(workerPayout), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(treasury), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(burnVault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(lockMint), isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ]);
  } catch (error) {
    console.log(`[solana] distribute_fees: ${error}`);
    return null;
  }
}

export async function anchorRegisterWorker(
  operatorPubkey: string,
  role: string,
  hardwareTier: string,
  teeCapable: boolean,
): Promise<string | null> {
  if (!config.solanaRpcUrl || config.solanaRpcUrl.includes("localhost")) return null;
  try {
    const kp = loadKeypair();
    if (!kp) return null;
    const opKey = new PublicKey(operatorPubkey);
    const [workerPda] = derivePda(PROGRAM_IDS.providerRegistry, [Buffer.from("worker"), opKey.toBuffer()]);
    const data = Buffer.concat([
      anchorDiscriminator("register_worker"),
      borshString(role),
      borshString(hardwareTier),
      borshBool(teeCapable),
    ]);
    return sendAnchorIx(PROGRAM_IDS.providerRegistry, data, [
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: opKey, isSigner: false, isWritable: false },
      { pubkey: workerPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]);
  } catch (error) {
    console.log(`[solana] register_worker: ${error}`);
    return null;
  }
}

export async function getRecentSlots(): Promise<number> {
  try {
    const result = await solanaRpc<number>("getSlot", []);
    return result.result ?? 0;
  } catch {
    return 0;
  }
}
