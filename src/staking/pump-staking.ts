import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { config } from "../config.js";
import { tryPublicKey } from "../solana.js";

/** c0mpute-compatible devnet staking program (mint-agnostic Token-2022 vault). */
export const DEFAULT_STAKING_PROGRAM_ID = "BU3JcQJBsFZwNV2DHSPeu3hKLsfarLS2AU5RuVhJrYKM";

export function stakingProgramPubkey(): PublicKey | null {
  return tryPublicKey(config.stakingProgramId || DEFAULT_STAKING_PROGRAM_ID);
}

export function pumpMintPubkey(): PublicKey | null {
  return tryPublicKey(config.pumpTokenMint);
}

export function derivePumpStakeAuthority(ownerWallet: string): PublicKey | null {
  const owner = tryPublicKey(ownerWallet);
  const program = stakingProgramPubkey();
  if (!owner || !program) return null;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), owner.toBuffer()],
    program,
  )[0];
}

export function derivePumpStakeVault(ownerWallet: string): PublicKey | null {
  const mint = pumpMintPubkey();
  const authority = derivePumpStakeAuthority(ownerWallet);
  if (!mint || !authority) return null;
  return getAssociatedTokenAddressSync(mint, authority, true, TOKEN_2022_PROGRAM_ID);
}

export function derivePumpOwnerAta(ownerWallet: string): PublicKey | null {
  const owner = tryPublicKey(ownerWallet);
  const mint = pumpMintPubkey();
  if (!owner || !mint) return null;
  const allowOffCurve = !PublicKey.isOnCurve(owner.toBuffer());
  return getAssociatedTokenAddressSync(mint, owner, allowOffCurve, TOKEN_2022_PROGRAM_ID);
}

export interface PumpStakeAddresses {
  stake_mint: string;
  staking_program_id: string;
  stake_authority: string;
  stake_vault_ata: string;
  owner_ata: string;
  token_decimals: number;
  token_symbol: string;
}

export function buildPumpStakeAddresses(ownerWallet: string): PumpStakeAddresses | null {
  const mint = pumpMintPubkey();
  const program = stakingProgramPubkey();
  const authority = derivePumpStakeAuthority(ownerWallet);
  const vault = derivePumpStakeVault(ownerWallet);
  const ownerAta = derivePumpOwnerAta(ownerWallet);
  if (!mint || !program || !authority || !vault || !ownerAta) return null;

  return {
    stake_mint: mint.toBase58(),
    staking_program_id: program.toBase58(),
    stake_authority: authority.toBase58(),
    stake_vault_ata: vault.toBase58(),
    owner_ata: ownerAta.toBase58(),
    token_decimals: config.pumpTokenDecimals,
    token_symbol: config.pumpTokenSymbol,
  };
}
