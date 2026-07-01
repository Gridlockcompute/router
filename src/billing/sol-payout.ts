import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { config } from "../config.js";
import { creditsToSol } from "./pricing.js";

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export function isTreasuryPayoutConfigured(): boolean {
  const raw = config.treasuryWalletKey?.trim();
  return Boolean(raw);
}

function loadTreasuryKeypair(): Keypair {
  const raw = config.treasuryWalletKey?.trim();
  if (!raw) throw new Error("Treasury payout key not configured (TREASURY_WALLET_KEY)");
  if (raw.startsWith("[") || raw.startsWith("{")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const path = expandHome(raw);
  if (existsSync(path)) {
    const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  throw new Error(`Invalid TREASURY_WALLET_KEY: ${raw.slice(0, 24)}…`);
}

export function creditsToLamports(credits: number): bigint {
  if (credits <= 0 || config.lamportsPerCredit <= 0) return 0n;
  return BigInt(Math.round(credits * config.lamportsPerCredit));
}

/** Send native SOL from treasury to worker wallet. */
export async function sendSolPayout(destAddress: string, credits: number): Promise<string> {
  const lamports = creditsToLamports(credits);
  if (lamports <= 0n) throw new Error("Payout amount too small");

  const treasury = loadTreasuryKeypair();
  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const dest = new PublicKey(destAddress);

  const balance = await connection.getBalance(treasury.publicKey);
  if (BigInt(balance) < lamports + 5000n) {
    throw new Error(
      `Treasury underfunded for payout (${creditsToSol(credits)} SOL requested, ${balance / 1e9} SOL on hand)`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: dest,
      lamports: Number(lamports),
    }),
  );
  tx.feePayer = treasury.publicKey;
  return sendAndConfirmTransaction(connection, tx, [treasury]);
}
