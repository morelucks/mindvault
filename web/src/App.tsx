import React, { useEffect, useState } from "react";
import { EditPriceModal } from "./components/EditPriceModal.js";
import { TransferOwnershipModal } from "./components/TransferOwnershipModal.js";
import { RegisterModal } from "./components/RegisterModal.js";
import { ExplorerLink } from "./components/ExplorerLink.js";
import { fetchMyResources, fetchRegistryStatus } from "./api/resources.js";

interface Resource {
  id: string;
  title: string;
  price: string;
  resourceType: string;
  publisherName?: string;
  walletAddress: string;
  verificationStatus: string;
  onchainStatus: string;
  onchainTxHash?: string;
  listed: boolean;
}

type ActiveModal =
  | { kind: "editPrice"; resource: Resource }
  | { kind: "transferOwnership"; resource: Resource }
  | { kind: "register"; resource: Resource }
  | null;

const API_KEY = import.meta.env.VITE_API_KEY ?? "";

export default function App() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [registryCount, setRegistryCount] = useState<number | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);

  useEffect(() => {
    if (API_KEY) {
      fetchMyResources(API_KEY).then(setResources).catch(console.error);
    } else {
      fetch("/resources").then((r) => r.json()).then(setResources).catch(console.error);
    }

    fetchRegistryStatus()
      .then((s) => setRegistryCount(s.resourceCount))
      .catch(console.error);
  }, []);

  function handlePriceConfirmed(id: string, price: string) {
    setResources((prev) => prev.map((r) => (r.id === id ? { ...r, price } : r)));
    setActiveModal(null);
  }

  function handleOwnershipConfirmed(id: string, newCreator: string) {
    setResources((prev) =>
      prev.map((r) => (r.id === id ? { ...r, walletAddress: newCreator } : r))
    );
    setActiveModal(null);
  }

  function handleRegistrationConfirmed(id: string, txHash: string) {
    setResources((prev) =>
      prev.map((r) => (r.id === id ? { ...r, onchainStatus: "registered" } : r))
    );
    setActiveModal(null);
  }

  const needsRegistration = (r: Resource) =>
    r.verificationStatus === "verified" && r.onchainStatus !== "registered";

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-gray-900">MindVault</h1>
        {registryCount !== null && (
          <p className="text-sm text-gray-500">
            Registry:{" "}
            <span className="font-semibold text-indigo-600">{registryCount}</span>{" "}
            resource{registryCount !== 1 ? "s" : ""} registered on-chain
          </p>
        )}
      </div>

      {API_KEY && resources.some(needsRegistration) && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-800">
            {resources.filter(needsRegistration).length} resource(s) verified but not yet registered on-chain.
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {resources.map((r) => (
          <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="font-semibold text-gray-900">{r.title}</p>
            {r.publisherName && (
              <p className="mt-1 text-sm text-gray-500">by {r.publisherName}</p>
            )}
            <p className="mt-1 truncate text-xs text-gray-400" title={r.walletAddress}>
              Owner:{" "}
              <ExplorerLink type="account" value={r.walletAddress} className="text-gray-500">
                {r.walletAddress}
              </ExplorerLink>
            </p>

            <div className="mt-2 flex flex-wrap gap-1">
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                r.verificationStatus === "verified"
                  ? "bg-green-100 text-green-700"
                  : r.verificationStatus === "rejected"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-600"
              }`}>
                {r.verificationStatus}
              </span>
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                r.onchainStatus === "registered"
                  ? "bg-indigo-100 text-indigo-700"
                  : r.onchainStatus === "failed"
                  ? "bg-red-100 text-red-700"
                  : r.onchainStatus === "pending"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-gray-100 text-gray-500"
              }`}>
                {r.onchainStatus === "none" ? "not on-chain" : r.onchainStatus}
              </span>
              {r.onchainStatus === "registered" && r.onchainTxHash && (
                <ExplorerLink
                  type="tx"
                  value={r.onchainTxHash}
                  className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium"
                >
                  View on Explorer ↗
                </ExplorerLink>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-sm font-medium text-indigo-600">{r.price} USDC</span>
              <div className="flex gap-1">
                {API_KEY && needsRegistration(r) && (
                  <button
                    onClick={() => setActiveModal({ kind: "register", resource: r })}
                    className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600"
                  >
                    Register on-chain
                  </button>
                )}
                {API_KEY && (
                  <>
                    <button
                      onClick={() => setActiveModal({ kind: "editPrice", resource: r })}
                      className="rounded-lg bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                    >
                      Edit price
                    </button>
                    <button
                      onClick={() => setActiveModal({ kind: "transferOwnership", resource: r })}
                      className="rounded-lg bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200"
                    >
                      Transfer
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {activeModal?.kind === "editPrice" && (
        <EditPriceModal
          resourceId={activeModal.resource.id}
          currentPrice={activeModal.resource.price}
          apiKey={API_KEY}
          onClose={() => setActiveModal(null)}
          onConfirmed={(price) => handlePriceConfirmed(activeModal.resource.id, price)}
        />
      )}

      {activeModal?.kind === "transferOwnership" && (
        <TransferOwnershipModal
          resourceId={activeModal.resource.id}
          apiKey={API_KEY}
          onClose={() => setActiveModal(null)}
          onConfirmed={(newCreator) =>
            handleOwnershipConfirmed(activeModal.resource.id, newCreator)
          }
        />
      )}

      {activeModal?.kind === "register" && (
        <RegisterModal
          resourceId={activeModal.resource.id}
          apiKey={API_KEY}
          onClose={() => setActiveModal(null)}
          onConfirmed={(txHash) =>
            handleRegistrationConfirmed(activeModal.resource.id, txHash)
          }
        />
      )}
    </div>
  );
}
