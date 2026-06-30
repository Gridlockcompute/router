/**
 * Full on-chain job lifecycle: open → assign → commit → finalize → settle → distribute.
 */
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
import { parseAttestationHash } from "./attestation.js";
import { config, PROGRAM_IDS } from "./config.js";
import { solanaRpc, tryPublicKey } from "./solana.js";
import type { WorkerRecord } from "./types.js";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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

function borshU64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function borshOptionBytes32(value: Buffer | null): Buffer {
  if (!value) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), value]);
}

function loadKeypair(): Keypair | null {
  try {
    const raw = readFileSync(config.routerKeypairPath, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    return null;
  }
}

export function jobIdBytes(jobId: string): Buffer {
  return createHash("sha256").update(jobId).digest();
}

function derivePda(programId: string, seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0];
}

function lockAccountsReady(): boolean {
  const { lockMint, feeVault, customerWallet } = config;
  return Boolean(lockMint && feeVault && customerWallet);
}

async function sendIx(
  programId: string,
  data: Buffer,
  accounts: AccountMeta[],
): Promise<string | null> {
  const kp = loadKeypair();
  if (!kp) return null;

  const rpc = await solanaRpc<{ value: { blockhash: string } }>("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  const blockhash = rpc.result?.value.blockhash;
  if (!blockhash) return null;

  const ix = new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: accounts,
    data,
  });
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  const result = await solanaRpc<string>("sendTransaction", [
    Buffer.from(tx.serialize()).toString("base64"),
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" },
  ]);
  if (result.error) {
    console.log(`[solana] tx error:`, result.error);
    return null;
  }
  const sig = result.result ?? null;
  if (sig) console.log(`[solana] tx: ${sig}`);
  return sig;
}

export async function confirmTx(signature: string, maxMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await solanaRpc<{ value: { confirmationStatus?: string; err?: unknown }[] }>(
      "getSignatureStatuses",
      [[signature], { searchTransactionHistory: true }],
    );
    const status = res.result?.value?.[0];
    if (status?.err) {
      console.log(`[solana] tx failed on-chain: ${JSON.stringify(status.err)}`);
      return false;
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`[solana] tx confirmation timeout: ${signature}`);
  return false;
}

async function sendAndConfirm(
  programId: string,
  data: Buffer,
  accounts: AccountMeta[],
): Promise<string | null> {
  const sig = await sendIx(programId, data, accounts);
  if (!sig) return null;
  return (await confirmTx(sig)) ? sig : null;
}

/** Router opens job escrow (devnet: router acts as customer). */
export async function anchorOpenJob(
  jobId: string,
  slaTier: string,
  feeLock: number,
  confidential: boolean,
): Promise<boolean> {
  if (!config.solanaSettlementEnabled || !lockAccountsReady()) return false;
  const kp = loadKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const payment = BigInt(Math.max(1, Math.floor(feeLock * 1_000_000_000)));
  const [jobPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("job"), id],
    new PublicKey(PROGRAM_IDS.jobScheduler),
  );
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("job_escrow"), id],
    new PublicKey(PROGRAM_IDS.jobScheduler),
  );
  const schedulerAuth = derivePda(PROGRAM_IDS.jobScheduler, [Buffer.from("job_scheduler")]);

  const data = Buffer.concat([
    anchorDiscriminator("open_job"),
    id,
    borshString(slaTier),
    borshU64(payment),
    borshBool(confidential),
  ]);

  return (await sendAndConfirm(PROGRAM_IDS.jobScheduler, data, [
    { pubkey: kp.publicKey, isSigner: true, isWritable: true },
    { pubkey: jobPda, isSigner: false, isWritable: true },
    { pubkey: escrowPda, isSigner: false, isWritable: true },
    { pubkey: schedulerAuth, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(config.customerWallet), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(config.lockMint), isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ])) !== null;
}

export async function anchorAssignWorker(jobId: string, workerPubkey: string): Promise<boolean> {
  if (!config.solanaSettlementEnabled) return false;
  const worker = tryPublicKey(workerPubkey);
  if (!worker) {
    console.log(`[solana] assign_worker skipped: invalid worker pubkey ${workerPubkey.slice(0, 12)}…`);
    return false;
  }
  const kp = loadKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const jobPda = derivePda(PROGRAM_IDS.jobScheduler, [Buffer.from("job"), id]);

  const data = Buffer.concat([anchorDiscriminator("assign_worker"), id, worker.toBuffer()]);
  return (await sendAndConfirm(PROGRAM_IDS.jobScheduler, data, [
    { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    { pubkey: jobPda, isSigner: false, isWritable: true },
  ])) !== null;
}

export async function anchorCommitReceipt(
  jobId: string,
  slaTier: string,
  ttftMs: number,
  tpotMs: number,
  slaMet: boolean,
  confidential: boolean,
  attestationHash: string | null = null,
): Promise<boolean> {
  if (!config.solanaSettlementEnabled) return false;
  const kp = loadKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const receipt = derivePda(PROGRAM_IDS.slaRegistry, [Buffer.from("receipt"), id]);
  const attestationBytes = confidential ? parseAttestationHash(attestationHash) : null;
  const data = Buffer.concat([
    anchorDiscriminator("commit_receipt"),
    id,
    borshString(slaTier),
    borshU32(ttftMs),
    borshU32(tpotMs),
    Buffer.alloc(64),
    borshBool(slaMet),
    borshBool(confidential),
    borshOptionBytes32(attestationBytes),
  ]);
  return (await sendAndConfirm(PROGRAM_IDS.slaRegistry, data, [
    { pubkey: kp.publicKey, isSigner: true, isWritable: true },
    { pubkey: receipt, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ])) !== null;
}

export async function anchorFinalizeReceipt(jobId: string): Promise<boolean> {
  if (!config.solanaSettlementEnabled) return false;
  const kp = loadKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const receipt = derivePda(PROGRAM_IDS.slaRegistry, [Buffer.from("receipt"), id]);
  const data = anchorDiscriminator("finalize_unchallenged");
  return (await sendAndConfirm(PROGRAM_IDS.slaRegistry, data, [
    { pubkey: kp.publicKey, isSigner: true, isWritable: false },
    { pubkey: receipt, isSigner: false, isWritable: true },
  ])) !== null;
}

function workerStakeAccount(worker: WorkerRecord): PublicKey | null {
  if (worker.stake_token_account) return new PublicKey(worker.stake_token_account);
  if (config.defaultWorkerStake) return new PublicKey(config.defaultWorkerStake);
  return null;
}

export async function anchorSettleOrPenalize(
  jobId: string,
  worker: WorkerRecord,
): Promise<boolean> {
  return (await anchorSettleOrPenalizeWithSig(jobId, worker)) !== null;
}

export async function anchorSettleOrPenalizeWithSig(
  jobId: string,
  worker: WorkerRecord,
): Promise<string | null> {
  if (!config.solanaSettlementEnabled || !lockAccountsReady()) return null;

  const stake = workerStakeAccount(worker);
  if (!stake) {
    console.log("[solana] settle_or_penalize: worker stake token account not configured");
    return null;
  }

  const id = jobIdBytes(jobId);
  const enforcer = derivePda(PROGRAM_IDS.slaEnforcer, [Buffer.from("sla_enforcer")]);
  const receipt = derivePda(PROGRAM_IDS.slaRegistry, [Buffer.from("receipt"), id]);
  const job = derivePda(PROGRAM_IDS.jobScheduler, [Buffer.from("job"), id]);
  const escrow = derivePda(PROGRAM_IDS.jobScheduler, [Buffer.from("job_escrow"), id]);
  const schedulerAuth = derivePda(PROGRAM_IDS.jobScheduler, [Buffer.from("job_scheduler")]);

  const data = Buffer.concat([anchorDiscriminator("settle_or_penalize"), id]);
  return sendAndConfirm(PROGRAM_IDS.slaEnforcer, data, [
    { pubkey: enforcer, isSigner: false, isWritable: false },
    { pubkey: receipt, isSigner: false, isWritable: true },
    { pubkey: job, isSigner: false, isWritable: true },
    { pubkey: stake, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(config.customerWallet), isSigner: false, isWritable: true },
    { pubkey: schedulerAuth, isSigner: false, isWritable: false },
    { pubkey: escrow, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(config.feeVault), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(config.lockMint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(PROGRAM_IDS.jobScheduler), isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
  ]);
}

export async function anchorDistributeFees(amountLock: number): Promise<string | null> {
  if (!config.solanaSettlementEnabled || !lockAccountsReady()) return null;
  const { lockMint, feeVault, stakerPool, workerPayout, treasury, burnVault } = config;
  if (!stakerPool || !workerPayout || !treasury || !burnVault) return null;

  const collector = derivePda(PROGRAM_IDS.feeCollector, [Buffer.from("fee_collector")]);
  const data = Buffer.concat([anchorDiscriminator("distribute_fees"), borshU64(amountLock)]);
  return sendAndConfirm(PROGRAM_IDS.feeCollector, data, [
    { pubkey: collector, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(feeVault), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(stakerPool), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(workerPayout), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(treasury), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(burnVault), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(lockMint), isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
  ]);
}

/** Full settlement pipeline after job completes. Returns primary on-chain tx sig if any step succeeded. */
export async function runOnChainSettlement(
  jobId: string,
  slaTier: string,
  ttftMs: number,
  tpotMs: number,
  slaMet: boolean,
  confidential: boolean,
  worker: WorkerRecord,
  fee: number,
  attestationHash: string | null = null,
): Promise<string | null> {
  if (!config.solanaSettlementEnabled) return null;

  const amountBase = Math.floor(fee * 1_000_000_000);

  if (!(await anchorCommitReceipt(jobId, slaTier, ttftMs, tpotMs, slaMet, confidential, attestationHash))) {
    console.log("[solana] settlement aborted: commit_receipt failed");
    return null;
  }

  await new Promise((r) => setTimeout(r, 2500));

  if (!(await anchorFinalizeReceipt(jobId))) {
    console.log("[solana] settlement aborted: finalize_unchallenged failed");
    return null;
  }

  const settleSig = await anchorSettleOrPenalizeWithSig(jobId, worker);
  if (!settleSig) {
    console.log("[solana] settle_or_penalize failed (penalty/escrow release)");
    return null;
  }

  if (amountBase > 0) {
    const distributeSig = await anchorDistributeFees(amountBase);
    return distributeSig ?? settleSig;
  }

  return settleSig;
}
