export interface WorkerRecord {
  address: string;
  role: string;
  endpoint: string;
  sla_tiers: string[];
  tee_capable: boolean;
  reliability_score: number;
  goodput_score: number;
  sla_pass_rate: number;
  p99_ttft_ms: number;
  status: string;
  staked_lock: number;
  hardware_tier: string;
  jobs_today: number;
  earnings_today: number;
  penalties_paid: number;
  is_confidential: boolean;
  last_heartbeat: number;
  registered_at: number;
  /** Token-2022 LOCK account debited on SLA miss (PermanentDelegate). */
  stake_token_account?: string;
  grid_points?: number;
}

export interface JobRecord {
  id: string;
  customer: string;
  model: string;
  sla_tier: string;
  ttft_ms: number;
  tpot_ms: number;
  sla_met: boolean;
  confidential: boolean;
  worker: string;
  worker_address: string;
  decode_worker?: string | null;
  ts: number;
  penalty_paid?: number | null;
  fee: number;
  status: string;
  cache_warm?: boolean;
  attestation_hash?: string | null;
  owner_wallet?: string | null;
  api_key_id?: string | null;
  prompt_tokens?: number;
  completion_tokens?: number;
  settlement_tx?: string | null;
  escrow_customer_wallet?: string | null;
}

export interface BillingInvoiceRecord {
  id: string;
  owner_wallet: string;
  period_year: number;
  period_month: number;
  period_label: string;
  amount_lock: number;
  penalties_credited_lock: number;
  request_count: number;
  token_count: number;
  status: "open" | "paid" | "paid_offchain";
  settlement_tx: string | null;
  settled_at: string | null;
  created_at: string;
}

export interface GridlockOptions {
  sla?: string;
  privacy?: boolean;
}

export interface Message {
  role: string;
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  gridlock?: GridlockOptions;
}

export interface RegisterWorkerRequest {
  operator_pubkey: string;
  role: string;
  hardware_tier: string;
  endpoint?: string;
  tee_capable?: boolean;
  is_confidential?: boolean;
}

export interface HeartbeatRequest {
  worker_address: string;
  goodput_score?: number;
  p99_ttft_ms?: number;
}

export type WorkerRuntimeStatus = "Active" | "Paused" | "Stopping" | "AutoGated";

export interface SetWorkerStatusRequest {
  status: WorkerRuntimeStatus;
}

export interface LiveEvent {
  type: string;
  id: string;
  sla_tier: string;
  ttft_ms: number;
  tpot_ms: number;
  sla_met: boolean;
  penalty: number | null;
  worker: string;
  ts: number;
}

export interface ApiKeyRecord {
  id: string;
  key_hash: string;
  key_prefix: string;
  owner_wallet: string;
  name: string;
  default_sla: string;
  tee_required: boolean;
  allowed_ips: string[] | null;
  request_count: number;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** Public API key row (never includes hash or secret). */
export type ApiKeyPublic = Omit<ApiKeyRecord, "key_hash" | "is_active">;

export interface ApiKeyContext {
  id: string;
  owner_wallet: string;
  key_prefix: string;
  default_sla: string;
  tee_required: boolean;
  allowed_ips: string[] | null;
  source: "database" | "env";
}

export interface CreateApiKeyRequest {
  name: string;
  kind?: "prod" | "dev";
  default_sla?: string;
  tee_required?: boolean;
  allowed_ips?: string[];
}

export interface UpdateApiKeyRequest {
  name?: string;
  default_sla?: string;
  tee_required?: boolean;
  allowed_ips?: string[] | null;
}
