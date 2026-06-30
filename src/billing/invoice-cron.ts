import { syncInvoicesForWallet } from "./invoices.js";
import { dbListBillingWallets, supabaseConfigured } from "../db.js";
import { jobsStore } from "../state.js";
import { jobBelongsToWallet } from "./aggregate.js";

let lastClosedPeriod = "";

function currentPeriodKey(now = new Date()): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

function walletsFromMemory(): string[] {
  const set = new Set<string>();
  for (const job of jobsStore) {
    if (job.owner_wallet) set.add(job.owner_wallet);
    else if (job.customer && job.customer.length >= 32) set.add(job.customer);
  }
  return [...set];
}

export async function closeInvoicesForAllWallets(): Promise<number> {
  const wallets = supabaseConfigured()
    ? await dbListBillingWallets()
    : walletsFromMemory();

  let count = 0;
  for (const wallet of wallets) {
    await syncInvoicesForWallet(wallet);
    count += 1;
  }
  return count;
}

export function startInvoiceCron(): void {
  if (process.env.GRIDLOCK_INVOICE_CRON === "false") {
    return;
  }

  const intervalMs = Number(process.env.GRIDLOCK_INVOICE_CRON_MS ?? 3_600_000);
  lastClosedPeriod = currentPeriodKey();

  const tick = async () => {
    const period = currentPeriodKey();
    const isNewMonth = period !== lastClosedPeriod;
    try {
      const n = await closeInvoicesForAllWallets();
      if (isNewMonth) {
        console.log(`[invoice-cron] closed/synced invoices for ${n} wallets (new period ${period})`);
        lastClosedPeriod = period;
      }
    } catch (err) {
      console.log(`[invoice-cron] failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  void tick();
  setInterval(() => void tick(), intervalMs);
  console.log(`[invoice-cron] started (every ${Math.round(intervalMs / 1000)}s)`);
}

export async function closeInvoicesForWallet(wallet: string) {
  return syncInvoicesForWallet(wallet);
}
