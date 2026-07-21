"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Download,
  Film,
  Library,
  Search,
  UserRound,
} from "lucide-react";
import { completeDigitalProductSaleAction } from "./commerceActions";

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
};

type DigitalProductOption = {
  catalogItemId: string;
  name: string;
  itemType: string;
  price: number;
  summary: string | null;
  skillLevel: string | null;
  danceStyle: string | null;
};

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function clientName(client: ClientOption) {
  return (
    `${client.first_name} ${client.last_name}`.trim() ||
    client.email ||
    "Client"
  );
}

function ProductIcon({ itemType }: { itemType: string }) {
  if (itemType === "video_series") return <Library className="h-5 w-5" />;
  if (itemType === "digital_download") {
    return <Download className="h-5 w-5" />;
  }
  return <Film className="h-5 w-5" />;
}

export default function DigitalProductSaleForm({
  clients,
  products,
}: {
  clients: ClientOption[];
  products: DigitalProductOption[];
}) {
  const [clientSearch, setClientSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [externalReference, setExternalReference] = useState("");
  const [notes, setNotes] = useState("");

  const selectedProduct =
    products.find((product) => product.catalogItemId === selectedProductId) ??
    null;

  const filteredClients = useMemo(() => {
    const query = clientSearch.trim().toLowerCase();
    if (!query) return clients;

    return clients.filter((client) =>
      `${client.first_name} ${client.last_name} ${client.email ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }, [clientSearch, clients]);

  const filteredProducts = useMemo(() => {
    const query = productSearch.trim().toLowerCase();
    if (!query) return products;

    return products.filter((product) =>
      `${product.name} ${product.summary ?? ""} ${product.skillLevel ?? ""} ${
        product.danceStyle ?? ""
      }`
        .toLowerCase()
        .includes(query),
    );
  }, [productSearch, products]);

  const ready = Boolean(selectedClientId && selectedProduct);

  return (
    <form
      action={completeDigitalProductSaleAction}
      className="space-y-6"
    >
      <input type="hidden" name="clientId" value={selectedClientId} />
      <input
        type="hidden"
        name="catalogItemId"
        value={selectedProductId}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Step 1</p>
              <h2 className="text-xl font-semibold text-slate-950">
                Choose the student
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Digital access requires a linked student account. Walk-in
                purchases are intentionally blocked.
              </p>
            </div>
          </div>

          <div className="relative mt-5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              placeholder="Search linked clients"
              className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm"
            />
          </div>

          <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-1">
            {filteredClients.map((client) => {
              const active = selectedClientId === client.id;

              return (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => setSelectedClientId(client.id)}
                  className={`w-full rounded-2xl border p-4 text-left ${
                    active
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                      : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">
                        {clientName(client)}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {client.email || "No linked account email"}
                      </p>
                    </div>
                    {active ? (
                      <CheckCircle2 className="h-5 w-5 text-[var(--brand-primary)]" />
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <p className="text-sm text-slate-500">Step 2</p>
            <h2 className="text-xl font-semibold text-slate-950">
              Choose digital content
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Only published videos, series, and downloads appear here.
            </p>
          </div>

          <div className="relative mt-5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Search digital catalog"
              className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm"
            />
          </div>

          <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-1">
            {filteredProducts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
                No published digital products are available.
              </div>
            ) : (
              filteredProducts.map((product) => {
                const active = selectedProductId === product.catalogItemId;

                return (
                  <button
                    key={product.catalogItemId}
                    type="button"
                    onClick={() =>
                      setSelectedProductId(product.catalogItemId)
                    }
                    className={`w-full rounded-2xl border p-4 text-left ${
                      active
                        ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div className="rounded-xl bg-white p-2 text-[var(--brand-primary)]">
                          <ProductIcon itemType={product.itemType} />
                        </div>
                        <div>
                          <p className="font-semibold text-slate-950">
                            {product.name}
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            {[product.skillLevel, product.danceStyle]
                              .filter(Boolean)
                              .join(" · ") || "Digital content"}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-slate-950">
                          {money(product.price)}
                        </p>
                        {active ? (
                          <CheckCircle2 className="ml-auto mt-2 h-5 w-5 text-[var(--brand-primary)]" />
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">
          Collect payment and grant access
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          The order, payment, and entitlement are created together. Repeating
          the sale will not create duplicate active access.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-medium text-slate-700">
            Payment method
            <select
              name="paymentMethod"
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            >
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="card">External card / Tap to Pay</option>
              <option value="ach">ACH</option>
              <option value="venmo">Venmo</option>
              <option value="zelle">Zelle</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-slate-700">
            External reference
            <input
              name="externalReference"
              value={externalReference}
              onChange={(event) => setExternalReference(event.target.value)}
              maxLength={180}
              placeholder="Optional payment reference"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>
        </div>

        <label className="mt-4 block space-y-2 text-sm font-medium text-slate-700">
          Notes
          <textarea
            name="notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          />
        </label>

        <div className="mt-5 flex items-center justify-between gap-4 rounded-2xl bg-slate-50 p-4">
          <div>
            <p className="text-sm text-slate-500">Total</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {money(selectedProduct?.price ?? 0)}
            </p>
          </div>
          <button
            disabled={!ready}
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Complete sale and grant access
          </button>
        </div>
      </section>
    </form>
  );
}
