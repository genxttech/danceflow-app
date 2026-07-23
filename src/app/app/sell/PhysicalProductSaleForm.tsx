"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  CreditCard,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingBag,
  UserRound,
} from "lucide-react";
import {
  completePhysicalProductSaleAction,
  startPhysicalProductTerminalSaleAction,
} from "./commerceActions";

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
};

type ProductOption = {
  catalogItemId: string;
  catalogName: string;
  variantId: string;
  variantName: string;
  sku: string | null;
  size: string | null;
  color: string | null;
  unitPrice: number;
  quantityOnHand: number;
  taxable: boolean;
};

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function clientName(client: ClientOption) {
  return `${client.first_name} ${client.last_name}`.trim() || client.email || "Client";
}

export default function PhysicalProductSaleForm({
  clients,
  products,
  hasOnlineReader,
}: {
  clients: ClientOption[];
  products: ProductOption[];
  hasOnlineReader: boolean;
}) {
  const [customerMode, setCustomerMode] = useState<"client" | "walk_in">("client");
  const [clientSearch, setClientSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [guestName, setGuestName] = useState("");
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [discountTotal, setDiscountTotal] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [externalReference, setExternalReference] = useState("");
  const [notes, setNotes] = useState("");

  const selectedProduct = useMemo(
    () => products.find((product) => product.variantId === selectedVariantId) ?? null,
    [products, selectedVariantId],
  );

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
      `${product.catalogName} ${product.variantName} ${product.sku ?? ""} ${
        product.size ?? ""
      } ${product.color ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }, [productSearch, products]);

  const subtotal = selectedProduct ? selectedProduct.unitPrice * quantity : 0;
  const discount = Math.min(
    Math.max(Number(discountTotal || 0), 0),
    subtotal,
  );
  const total = Math.max(0, subtotal - discount);
  const readyCustomer =
    customerMode === "client" ? Boolean(selectedClientId) : Boolean(guestName.trim());
  const ready =
    readyCustomer &&
    Boolean(selectedProduct) &&
    quantity > 0 &&
    quantity <= Number(selectedProduct?.quantityOnHand ?? 0);

  function SharedFields() {
    return (
      <>
        <input
          type="hidden"
          name="clientId"
          value={customerMode === "client" ? selectedClientId : ""}
        />
        <input
          type="hidden"
          name="guestName"
          value={customerMode === "walk_in" ? guestName : ""}
        />
        <input type="hidden" name="variantId" value={selectedVariantId} />
        <input type="hidden" name="quantity" value={quantity} />
        <input type="hidden" name="discountTotal" value={discountTotal || "0"} />
        <input type="hidden" name="notes" value={notes} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Step 1</p>
              <h2 className="text-xl font-semibold text-slate-950">
                Choose customer
              </h2>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setCustomerMode("client")}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                customerMode === "client"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600"
              }`}
            >
              Existing client
            </button>
            <button
              type="button"
              onClick={() => setCustomerMode("walk_in")}
              className={`rounded-xl px-3 py-2 text-sm font-semibold ${
                customerMode === "walk_in"
                  ? "bg-white text-slate-950 shadow-sm"
                  : "text-slate-600"
              }`}
            >
              Walk-in
            </button>
          </div>

          {customerMode === "client" ? (
            <>
              <div className="relative mt-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={clientSearch}
                  onChange={(event) => setClientSearch(event.target.value)}
                  placeholder="Search clients"
                  className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm"
                />
              </div>

              <div className="mt-4 max-h-[340px] space-y-2 overflow-y-auto pr-1">
                {filteredClients.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
                    No clients match this search.
                  </div>
                ) : filteredClients.map((client) => {
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
                            {client.email || "No email"}
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
            </>
          ) : (
            <label className="mt-5 block space-y-2 text-sm font-medium text-slate-700">
              Walk-in name
              <input
                value={guestName}
                onChange={(event) => setGuestName(event.target.value)}
                maxLength={120}
                placeholder="Customer name"
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
              />
            </label>
          )}
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <ShoppingBag className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Step 2</p>
              <h2 className="text-xl font-semibold text-slate-950">
                Choose product
              </h2>
            </div>
          </div>

          <div className="relative mt-5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={productSearch}
              onChange={(event) => setProductSearch(event.target.value)}
              placeholder="Product, variant, SKU..."
              className="w-full rounded-xl border border-slate-300 py-2.5 pl-10 pr-3 text-sm"
            />
          </div>

          <div className="mt-4 max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {filteredProducts.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
                No in-stock physical products match this search.
              </div>
            ) : (
              filteredProducts.map((product) => {
                const active = selectedVariantId === product.variantId;
                return (
                  <button
                    key={product.variantId}
                    type="button"
                    onClick={() => {
                      setSelectedVariantId(product.variantId);
                      setQuantity(1);
                    }}
                    className={`w-full rounded-2xl border p-4 text-left ${
                      active
                        ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-slate-950">
                          {product.catalogName}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {product.variantName}
                          {product.sku ? ` · ${product.sku}` : ""}
                        </p>
                        <p className="mt-2 text-xs text-slate-500">
                          {product.quantityOnHand} on hand
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-slate-950">
                          {money(product.unitPrice)}
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
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Step 3</p>
            <h2 className="text-xl font-semibold text-slate-950">
              Review and collect payment
            </h2>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl bg-slate-50 p-4 xl:col-span-2">
            <p className="text-sm text-slate-500">Selected item</p>
            <p className="mt-1 font-semibold text-slate-950">
              {selectedProduct
                ? `${selectedProduct.catalogName} · ${selectedProduct.variantName}`
                : "Not selected"}
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Quantity</p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                className="rounded-lg border border-slate-200 bg-white p-2"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="min-w-8 text-center font-semibold">{quantity}</span>
              <button
                type="button"
                onClick={() =>
                  setQuantity((value) =>
                    Math.min(
                      Number(selectedProduct?.quantityOnHand ?? 1),
                      value + 1,
                    ),
                  )
                }
                className="rounded-lg border border-slate-200 bg-white p-2"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          <label className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
            Discount
            <input
              value={discountTotal}
              onChange={(event) => setDiscountTotal(event.target.value)}
              inputMode="decimal"
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-950"
            />
          </label>

          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-4">
            <p className="text-sm text-[var(--brand-primary)]">Total</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--brand-primary)]">
              {money(total)}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-medium text-slate-700">
            Payment method
            <select
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
              value={externalReference}
              onChange={(event) => setExternalReference(event.target.value)}
              maxLength={180}
              placeholder="Optional card, check, Venmo, or Zelle reference"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>
        </div>

        <label className="mt-4 block space-y-2 text-sm font-medium text-slate-700">
          Notes
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            maxLength={500}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          />
        </label>

        <div className="mt-5 flex flex-wrap gap-3">
          <form action={completePhysicalProductSaleAction} className="w-full sm:w-auto">
            <SharedFields />
            <input type="hidden" name="paymentMethod" value={paymentMethod} />
            <input
              type="hidden"
              name="externalReference"
              value={externalReference}
            />
            <button
              disabled={!ready}
              className="w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto"
            >
              Complete {paymentMethod === "card" ? "external card" : paymentMethod} sale
            </button>
          </form>

          <form action={startPhysicalProductTerminalSaleAction} className="w-full sm:w-auto">
            <SharedFields />
            <button
              disabled={!ready || !hasOnlineReader || total <= 0}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 sm:w-auto"
            >
              <CreditCard className="h-4 w-4" />
              Send to card reader
            </button>
          </form>
        </div>

        {!hasOnlineReader ? (
          <p className="mt-3 text-sm font-medium text-amber-700">
            No online card reader is available. Use a manual or external payment
            method, or reconnect a reader in Billing &amp; Payouts.
          </p>
        ) : null}
      </section>
    </div>
  );
}
