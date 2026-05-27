#!/usr/bin/env node
/**
 * MindVault MCP Server
 * Exposes vault tools to AI agents via the Model Context Protocol.
 *
 * Tools:
 *   mindvault_setup_wallet   — create a sponsored Stellar wallet
 *   mindvault_wallet_info    — check address + USDC balance
 *   mindvault_browse         — list catalog
 *   mindvault_preview        — resource details + price
 *   mindvault_register       — register as publisher (API key stored in memory)
 *   mindvault_publish        — publish a link resource, pay verification via x402,
 *                              then sign the register invocation with the agent key
 *   mindvault_buy            — pay x402 and access a resource
 *   mindvault_agent_status   — verification agent earnings + activity
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Keypair, Networks, Asset, TransactionBuilder, Operation, BASE_FEE } from "@stellar/stellar-sdk";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ClientStellarSigner } from "@x402/stellar";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.MINDVAULT_URL ?? "https://mindvault-hyr3.onrender.com";
const SPONSORED_ACCOUNT_URL =
  process.env.SPONSORED_ACCOUNT_URL ??
  "https://stellar-sponsored-agent-account.onrender.com";
const HORIZON_URL =
  process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const USDC_CONTRACT =
  process.env.USDC_CONTRACT ??
  "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// ── In-memory agent state ─────────────────────────────────────────────────────

interface AgentWallet {
  publicKey: string;
  secretKey: string;
}

let agentWallet: AgentWallet | null = null;
let agentApiKey: string | null = null; // set after mindvault_register

// ── Helpers ───────────────────────────────────────────────────────────────────

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: text };
  }
}

function requireWallet(): AgentWallet {
  if (!agentWallet) {
    throw new Error(
      "No agent wallet configured. Run mindvault_setup_wallet first."
    );
  }
  return agentWallet;
}

function makeSigner(wallet: AgentWallet): ClientStellarSigner {
  const keypair = Keypair.fromSecret(wallet.secretKey);
  return new ClientStellarSigner(keypair, NETWORK_PASSPHRASE);
}

async function getUsdcBalance(publicKey: string): Promise<string> {
  const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (!res.ok) return "0";
  const data: any = await res.json();
  const usdcBalance = (data.balances ?? []).find(
    (b: any) =>
      b.asset_type === "credit_alphanum4" &&
      b.asset_code === "USDC"
  );
  return usdcBalance?.balance ?? "0";
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function setupWallet(): Promise<string> {
  const res = await jsonFetch(`${SPONSORED_ACCOUNT_URL}/create`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to create sponsored wallet: ${JSON.stringify(res.data)}`);
  }
  const { publicKey, secretKey } = res.data;
  agentWallet = { publicKey, secretKey };
  return `Wallet created.\nAddress: ${publicKey}\nSecret key stored in memory (not persisted).`;
}

async function walletInfo(): Promise<string> {
  const wallet = requireWallet();
  const balance = await getUsdcBalance(wallet.publicKey);
  return `Address: ${wallet.publicKey}\nUSDC Balance: ${balance}`;
}

async function browse(): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/resources`);
  if (!res.ok) throw new Error(`Browse failed: ${JSON.stringify(res.data)}`);
  const items: any[] = res.data;
  if (items.length === 0) return "No resources listed yet.";
  return items
    .map(
      (r) =>
        `[${r.id}] ${r.title} — $${r.price} USDC\n  ${r.description ?? ""}\n  ${r.accessUrl}`
    )
    .join("\n\n");
}

async function preview(resourceId: string): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/resources/${resourceId}/meta`);
  if (!res.ok) throw new Error(`Preview failed: ${JSON.stringify(res.data)}`);
  const r = res.data;
  return JSON.stringify(
    {
      id: r.id,
      title: r.title,
      description: r.description,
      price: `$${r.price} USDC`,
      type: r.resourceType,
      verificationStatus: r.verificationStatus,
      accessUrl: r.accessUrl,
    },
    null,
    2
  );
}

async function register(
  name: string,
  email: string,
  walletAddress?: string
): Promise<string> {
  const wallet = requireWallet();
  const address = walletAddress ?? wallet.publicKey;

  const res = await jsonFetch(`${BASE_URL}/publishers`, {
    method: "POST",
    body: JSON.stringify({ name, email, walletAddress: address }),
  });

  if (!res.ok) {
    throw new Error(`Register failed: ${JSON.stringify(res.data)}`);
  }

  agentApiKey = res.data.apiKey;
  return `Registered as publisher.\nID: ${res.data.id}\nAPI key stored in memory.`;
}

async function publish(args: {
  title: string;
  description?: string;
  price: string;
  externalUrl: string;
}): Promise<string> {
  const wallet = requireWallet();
  if (!agentApiKey) {
    throw new Error("Not registered. Run mindvault_register first.");
  }

  const signer = makeSigner(wallet);

  // Step 1: Create the resource record (pending verification)
  const createRes = await jsonFetch(`${BASE_URL}/resources`, {
    method: "POST",
    headers: { "x-api-key": agentApiKey },
    body: JSON.stringify({
      title: args.title,
      description: args.description,
      price: args.price,
      externalUrl: args.externalUrl,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Publish failed: ${JSON.stringify(createRes.data)}`);
  }

  const resource = createRes.data;

  // Step 2: Pay for verification via x402 using the agent wallet
  // The agent signs the Soroban auth entry for the USDC transfer
  const paidFetch = wrapFetchWithPayment(fetch, signer);

  const verifyRes = await paidFetch(`${BASE_URL}/verify-content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `Title: ${args.title}\nDescription: ${args.description ?? ""}\nURL: ${args.externalUrl}`,
      resourceId: resource.id,
    }),
  });

  const verifyData = await verifyRes.json().catch(() => null);

  if (!verifyRes.ok) {
    return (
      `Resource created (id: ${resource.id}) but verification payment failed.\n` +
      `Status: ${verifyRes.status}\n${JSON.stringify(verifyData)}`
    );
  }

  // Step 3: Sign the on-chain register invocation with the agent key
  // This records the publisher's wallet on-chain via a Soroban auth entry.
  // We reuse the same signer that paid for verification.
  const registerRes = await paidFetch(`${BASE_URL}/publishers/register-onchain`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": agentApiKey,
    },
    body: JSON.stringify({ resourceId: resource.id }),
  }).catch(() => null);

  const isOriginal = verifyData?.isOriginal ?? false;
  const flags: string[] = verifyData?.flags ?? [];

  return [
    `Resource published.`,
    `ID: ${resource.id}`,
    `Access URL: ${resource.accessUrl}`,
    `Verification: ${isOriginal ? "approved ✓" : "rejected ✗"}`,
    flags.length ? `Flags: ${flags.join("; ")}` : null,
    registerRes
      ? `On-chain register: ${registerRes.ok ? "signed ✓" : "skipped (endpoint not yet live)"}`
      : `On-chain register: skipped`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function buy(resourceId: string): Promise<string> {
  const wallet = requireWallet();
  const signer = makeSigner(wallet);
  const paidFetch = wrapFetchWithPayment(fetch, signer);

  const res = await paidFetch(`${BASE_URL}/resources/${resourceId}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Buy failed [${res.status}]: ${text}`);
  }

  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

async function agentStatus(): Promise<string> {
  const res = await jsonFetch(`${BASE_URL}/agent/status`);
  if (!res.ok) throw new Error(`Agent status failed: ${JSON.stringify(res.data)}`);
  return JSON.stringify(res.data, null, 2);
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mindvault", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mindvault_setup_wallet",
      description:
        "Create a Stellar wallet using the sponsored account protocol. No XLM needed upfront.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_wallet_info",
      description: "Check the agent wallet address and USDC balance.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_browse",
      description: "List all available resources in the MindVault catalog.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "mindvault_preview",
      description: "Get details and price for a specific resource.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: { type: "string", description: "Resource ID" },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_register",
      description:
        "Register as a publisher using the agent wallet. Stores the API key in memory.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          walletAddress: {
            type: "string",
            description: "Optional — defaults to agent wallet address",
          },
        },
        required: ["name", "email"],
      },
    },
    {
      name: "mindvault_publish",
      description:
        "Publish a link resource. The agent wallet pays for verification via x402 and signs the on-chain register invocation.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          price: { type: "string", description: "USDC amount, e.g. '0.50'" },
          externalUrl: { type: "string", description: "URL of the resource" },
        },
        required: ["title", "price", "externalUrl"],
      },
    },
    {
      name: "mindvault_buy",
      description: "Pay USDC via x402 and access a resource.",
      inputSchema: {
        type: "object",
        properties: {
          resourceId: { type: "string" },
        },
        required: ["resourceId"],
      },
    },
    {
      name: "mindvault_agent_status",
      description:
        "Check the verification agent's earnings, stats, and recent activity.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: string;

    switch (name) {
      case "mindvault_setup_wallet":
        result = await setupWallet();
        break;
      case "mindvault_wallet_info":
        result = await walletInfo();
        break;
      case "mindvault_browse":
        result = await browse();
        break;
      case "mindvault_preview":
        result = await preview(args.resourceId as string);
        break;
      case "mindvault_register":
        result = await register(
          args.name as string,
          args.email as string,
          args.walletAddress as string | undefined
        );
        break;
      case "mindvault_publish":
        result = await publish({
          title: args.title as string,
          description: args.description as string | undefined,
          price: args.price as string,
          externalUrl: args.externalUrl as string,
        });
        break;
      case "mindvault_buy":
        result = await buy(args.resourceId as string);
        break;
      case "mindvault_agent_status":
        result = await agentStatus();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
