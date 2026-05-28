/**
 * Reconciliation script for MindVault.
 *
 * Walks every resource in the database that is marked as `onchain_status =
 * "registered"`, fetches the matching entry from the vault-registry contract on
 * Stellar, and reports any discrepancies between the two. The script is
 * read-only — it does not modify the database or the contract.
 *
 * Run via `pnpm reconcile` (from `server/`) or `pnpm tsx scripts/reconcile.ts`.
 *
 * Exit codes:
 *   0 — all checked resources are in sync
 *   1 — one or more discrepancies were found
 *   2 — the script failed to run (config/network error)
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { resources } from "../src/db/schema.js";
import { getResource, resourceCount } from "../src/services/registryClient.js";

// USDC has 7 decimals on Soroban; 1 USDC == 10_000_000 stroops.
const STROOPS_PER_USDC = 10_000_000n;

interface MismatchEntry {
  resourceId: string;
  dbPrice: string;
  chainPrice: string;
  publisherWallet: string;
}

interface MissingOnChainEntry {
  resourceId: string;
  dbPrice: string;
  publisherWallet: string;
}

interface MissingInDbEntry {
  resourceId: string;
  chainPrice: string;
}

export interface ReconciliationSummary {
  checkedAt: string;
  totalChecked: number;
  inSync: number;
  mismatches: MismatchEntry[];
  missingOnChain: MissingOnChainEntry[];
  missingInDb: MissingInDbEntry[];
}

/** Convert a USDC string like "0.50" to stroops (bigint, 7 decimals). */
function usdcStringToStroops(usdc: string): bigint {
  const [whole, fracRaw = ""] = usdc.trim().split(".");
  const frac = (fracRaw + "0000000").slice(0, 7);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "") || "0";
  return sign * (BigInt(wholeAbs) * STROOPS_PER_USDC + BigInt(frac || "0"));
}

/** Convert stroops (bigint) back to a fixed 7-decimal USDC string. */
function stroopsToUsdcString(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = abs % STROOPS_PER_USDC;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/**
 * Print a human-readable summary block to stdout. Pure: only writes to stdout
 * and returns the exit code the caller should use. Kept side-effect-light so
 * it can be unit-tested independently of the DB/RPC calls above.
 */
export function printSummary(summary: ReconciliationSummary): 0 | 1 {
  const totalIssues =
    summary.mismatches.length +
    summary.missingOnChain.length +
    summary.missingInDb.length;

  const line = "========================================";
  const sub = "----------------------------------------";

  const out: string[] = [];
  out.push(line);
  out.push("MindVault Reconciliation Summary");
  out.push(`Run at: ${summary.checkedAt}`);
  out.push(`Resources checked:      ${summary.totalChecked}`);
  out.push(`In sync:                ${summary.inSync}`);
  out.push(`Price mismatches:       ${summary.mismatches.length}`);
  out.push(`Missing on-chain:       ${summary.missingOnChain.length}`);
  out.push(`Missing in DB:          ${summary.missingInDb.length}`);

  if (summary.mismatches.length > 0) {
    out.push("");
    out.push(`MISMATCHES (${summary.mismatches.length})`);
    out.push(sub);
    for (const m of summary.mismatches) {
      out.push(`Resource ID: ${m.resourceId}`);
      out.push(`DB price:    ${m.dbPrice} USDC`);
      out.push(`Chain price: ${m.chainPrice} USDC`);
      out.push(`Publisher:   ${m.publisherWallet}`);
      out.push("");
    }
  }

  if (summary.missingOnChain.length > 0) {
    out.push(`MISSING ON-CHAIN (${summary.missingOnChain.length})`);
    out.push(sub);
    for (const m of summary.missingOnChain) {
      out.push(`Resource ID: ${m.resourceId}`);
      out.push(`DB price:    ${m.dbPrice} USDC`);
      out.push(`Publisher:   ${m.publisherWallet}`);
      out.push("");
    }
  }

  if (summary.missingInDb.length > 0) {
    out.push(`MISSING IN DB (${summary.missingInDb.length})`);
    out.push(sub);
    for (const m of summary.missingInDb) {
      out.push(`Resource ID: ${m.resourceId}`);
      out.push(`Chain price: ${m.chainPrice} USDC`);
      out.push("");
    }
  }

  out.push(line);
  if (totalIssues === 0) {
    out.push("Result: ALL CLEAR");
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }
  out.push(`Result: NEEDS ATTENTION (${totalIssues} issues found)`);
  process.stdout.write(out.join("\n") + "\n");
  return 1;
}

async function reconcile(): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    checkedAt: new Date().toISOString(),
    totalChecked: 0,
    inSync: 0,
    mismatches: [],
    missingOnChain: [],
    missingInDb: [],
  };

  const registeredRows = await db
    .select()
    .from(resources)
    .where(eq(resources.onchainStatus, "registered"));

  summary.totalChecked = registeredRows.length;

  for (const row of registeredRows) {
    process.stdout.write(`Checking ${row.id} ... `);
    const onChain = await getResource(row.id);
    if (onChain === null) {
      process.stdout.write("MISSING ON-CHAIN\n");
      summary.missingOnChain.push({
        resourceId: row.id,
        dbPrice: row.price,
        publisherWallet: row.walletAddress,
      });
      continue;
    }

    const dbStroops = usdcStringToStroops(row.price);
    if (onChain.price !== dbStroops) {
      process.stdout.write(
        `PRICE MISMATCH (db=${row.price}, chain=${stroopsToUsdcString(
          onChain.price
        )})\n`
      );
      summary.mismatches.push({
        resourceId: row.id,
        dbPrice: row.price,
        chainPrice: stroopsToUsdcString(onChain.price),
        publisherWallet: row.walletAddress,
      });
      continue;
    }

    process.stdout.write("OK\n");
    summary.inSync++;
  }

  // The contract exposes count() but no enumeration, so we cannot list the IDs
  // of on-chain entries that have no DB row. We can still detect that there
  // *are* such entries by comparing counts, and surface a single placeholder
  // entry so the operator knows to investigate manually.
  try {
    const chainCount = await resourceCount();
    const dbRegisteredCount = registeredRows.length;
    if (chainCount > dbRegisteredCount) {
      const delta = chainCount - dbRegisteredCount;
      summary.missingInDb.push({
        resourceId: `<${delta} entr${delta === 1 ? "y" : "ies"} on-chain not in DB; contract has no enumeration>`,
        chainPrice: "n/a",
      });
    }
  } catch (err) {
    process.stderr.write(
      `Warning: could not read on-chain count for orphan check: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }

  return summary;
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes("--json");

  let summary: ReconciliationSummary;
  try {
    summary = await reconcile();
  } catch (err) {
    process.stderr.write(
      `Reconciliation failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(2);
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    const issues =
      summary.mismatches.length +
      summary.missingOnChain.length +
      summary.missingInDb.length;
    process.exit(issues === 0 ? 0 : 1);
  }

  const code = printSummary(summary);
  process.exit(code);
}

main();
