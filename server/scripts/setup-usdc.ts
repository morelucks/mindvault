/**
 * Set up USDC trustline and acquire testnet USDC for the platform agent wallet.
 *
 * Usage: npx tsx scripts/setup-usdc.ts
 */

import "dotenv/config";
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Horizon,
} from "@stellar/stellar-sdk";

const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

async function main() {
  const secretKey = process.env.AGENT_SECRET_KEY;
  if (!secretKey) {
    console.error("AGENT_SECRET_KEY not set in .env");
    process.exit(1);
  }

  const keypair = Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();
  const server = new Horizon.Server(HORIZON_URL);

  console.log(`Wallet: ${publicKey}\n`);

  // Check current balances
  const account = await server.loadAccount(publicKey);
  const usdcBalance = account.balances.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === TESTNET_USDC_ISSUER,
  );

  if (usdcBalance) {
    console.log(`USDC trustline already exists. Balance: ${(usdcBalance as any).balance} USDC`);
  } else {
    console.log("Adding USDC trustline...");

    const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    await server.submitTransaction(tx);
    console.log("Trustline added.");
  }

  // Get testnet USDC from friendbot-style faucet
  console.log("\nRequesting testnet USDC...");

  const faucetUrl = `https://friendbot.stellar.org?addr=${publicKey}`;
  // Friendbot only gives XLM. For USDC we need to use the testnet USDC issuer's distribution.
  // The standard approach is to use the Stellar Lab or a known testnet USDC faucet.
  // Let's try the common testnet USDC distribution endpoint:

  try {
    const resp = await fetch(`https://horizon-testnet.stellar.org/friendbot?addr=${publicKey}`);
    if (resp.ok) {
      console.log("Friendbot: topped up XLM.");
    }
  } catch {
    console.log("Friendbot XLM top-up skipped (may already have XLM).");
  }

  // For testnet USDC, we can do a path payment from the issuer if we have a distribution account,
  // or use the Stellar testnet token faucet. Let's check if there's a simpler way:
  // The x402 testnet facilitator uses the Soroban USDC contract, not classic USDC.
  // Contract address: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

  console.log(`
Note: x402 on Stellar uses the Soroban USDC token contract, not classic USDC.

Testnet USDC contract: CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

To get testnet USDC for x402:
  1. Go to https://lab.stellar.org
  2. Switch to Testnet
  3. Go to "Fund account" or use the SAC (Stellar Asset Contract) mint

Alternatively, visit https://xlm402.com to test x402 flows with small amounts.

Your wallet ${publicKey} now has a USDC trustline and is ready.
Once you acquire testnet USDC, the verification flow will work end-to-end.
  `);

  // Show final balances
  const updated = await server.loadAccount(publicKey);
  console.log("Current balances:");
  for (const bal of updated.balances) {
    if ((bal as any).asset_code) {
      console.log(`  ${(bal as any).asset_code}: ${(bal as any).balance}`);
    } else {
      console.log(`  XLM: ${(bal as any).balance}`);
    }
  }
}

main().catch(console.error);
