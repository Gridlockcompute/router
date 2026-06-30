import { createHash } from "node:crypto";
import {
  AccountMeta,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { config, PROGRAM_IDS } from "../config.js";
import { tryPublicKey } from "../solana.js";
import { deriveStakerVaultAddresses } from "./reads.js";

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

export function buildClaimUnstakeInstruction(ownerWallet: string): TransactionInstruction | null {
  const owner = tryPublicKey(ownerWallet);
  const mint = tryPublicKey(config.lockMint);
  if (!owner || !mint) return null;

  const vault = deriveStakerVaultAddresses(ownerWallet);
  if (!vault) return null;

  const programId = new PublicKey(PROGRAM_IDS.feeCollector);
  const [stakerVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("staker_vault"), owner.toBuffer()],
    programId,
  );
  const [stakePosition] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_position"), owner.toBuffer()],
    programId,
  );

  const stakerVault = new PublicKey(vault.vault_ata);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  const keys: AccountMeta[] = [
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: stakePosition, isSigner: false, isWritable: true },
    { pubkey: stakerVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: stakerVault, isSigner: false, isWritable: true },
    { pubkey: ownerAta, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(anchorDiscriminator("claim_unstake")),
  });
}

export async function buildClaimUnstakeTransaction(
  ownerWallet: string,
  blockhash: string,
): Promise<VersionedTransaction | null> {
  const owner = tryPublicKey(ownerWallet);
  const ix = buildClaimUnstakeInstruction(ownerWallet);
  if (!owner || !ix) return null;

  const msg = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(msg);
}
