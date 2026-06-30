import { createHash } from "node:crypto";
import type { WorkerRecord } from "./types.js";

/** Dev/staging: deterministic hash bound to job + worker + output prefix. */
export function computeJobAttestationHash(
  jobId: string,
  workerAddress: string,
  response: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      jobId,
      workerAddress,
      response: response.slice(0, 512),
    }))
    .digest("hex");
}

export function parseAttestationHash(hex: string | null | undefined): Buffer | null {
  if (!hex) return null;
  const clean = hex.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  return Buffer.from(clean, "hex");
}

export interface AttestationResult {
  hash: string | null;
  attestationValid: boolean;
}

/**
 * Confidential jobs require a valid attestation from a TEE-capable worker.
 * Production: replace dev hash check with NVIDIA NRAS / AMD SEV quote verification.
 */
export function resolveJobAttestation(params: {
  confidential: boolean;
  worker: WorkerRecord;
  jobId: string;
  response: string;
  workerAttestationHash?: string | null;
}): AttestationResult {
  if (!params.confidential) {
    return { hash: null, attestationValid: true };
  }

  if (!params.worker.tee_capable) {
    return { hash: null, attestationValid: false };
  }

  const expected = computeJobAttestationHash(
    params.jobId,
    params.worker.address,
    params.response,
  );
  const provided = (params.workerAttestationHash ?? expected).replace(/^0x/i, "");

  if (provided !== expected) {
    console.log(
      `[attestation] mismatch job=${params.jobId.slice(0, 8)} worker=${params.worker.address.slice(0, 8)}`,
    );
    return { hash: null, attestationValid: false };
  }

  return { hash: expected, attestationValid: true };
}

export function slaMetWithAttestation(
  latencyMet: boolean,
  confidential: boolean,
  attestation: AttestationResult,
): boolean {
  if (!latencyMet) return false;
  if (confidential && !attestation.attestationValid) return false;
  return true;
}
