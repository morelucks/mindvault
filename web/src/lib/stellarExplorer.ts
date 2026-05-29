export type StellarNetwork = "testnet" | "public";

// Defaults to testnet; override with VITE_STELLAR_NETWORK="public" for mainnet.
const NETWORK: StellarNetwork =
  (import.meta.env.VITE_STELLAR_NETWORK as StellarNetwork) ?? "testnet";

const EXPLORER_BASE = `https://stellar.expert/explorer/${NETWORK}`;

/** Stellar Explorer URL for a transaction hash. */
export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/tx/${txHash}`;
}

/** Stellar Explorer URL for an account / wallet address (G...). */
export function explorerAccountUrl(address: string): string {
  return `${EXPLORER_BASE}/account/${address}`;
}

/** Stellar Explorer URL for a Soroban contract id (C...). */
export function explorerContractUrl(contractId: string): string {
  return `${EXPLORER_BASE}/contract/${contractId}`;
}
