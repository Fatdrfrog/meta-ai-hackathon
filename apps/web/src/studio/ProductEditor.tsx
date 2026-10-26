import type { ApiProduct, ProductPatch } from "@vitrina/server/api";
import { useEffect, useId, useState, type KeyboardEvent } from "react";

export function ProductEditor({
  product,
  save,
  remove,
}: {
  product: ApiProduct;
  save: (patch: ProductPatch) => Promise<void>;
  remove: () => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(product.localName);
  const [price, setPrice] = useState(product.price === null ? "" : String(product.price));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(product.localName), [product.localName]);
  useEffect(() => setPrice(product.price === null ? "" : String(product.price)), [product.price]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function saveName() {
    const next = name.trim();
    if (!next) return setName(product.localName);
    if (next !== product.localName) void run(() => save({ localName: next }));
  }

  function savePrice() {
    const next = price.trim() === "" ? null : Number(price);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return setError("Enter the price as a number of tenge.");
    if (next !== product.price) void run(() => save({ price: next }));
  }

  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.currentTarget.blur();
  };

  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-name`} className="sr-only">
        Product name
      </label>
      {/* Two lines, so long Kazakh and Russian names stay readable in a narrow column. */}
      <textarea
        id={`${id}-name`}
        value={name}
        maxLength={120}
        rows={2}
        onChange={(e) => setName(e.target.value.replaceAll("\n", " "))}
        onBlur={saveName}
        onKeyDown={blurOnEnter}
        className="block w-full resize-none border-b border-transparent bg-transparent py-0.5 font-medium leading-snug outline-none hover:border-line focus:border-action"
      />
      <p className="truncate text-sm text-ink-soft" title={product.name}>
        {product.name}
      </p>
      {product.priceQuote && (
        <p className="text-sm leading-snug text-ink-soft">
          You said <q className="text-ink">{product.priceQuote}</q>
        </p>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-price`} className="text-sm text-ink-soft">
          Price
        </label>
        <input
          id={`${id}-price`}
          type="number"
          inputMode="numeric"
          min={0}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={savePrice}
          onKeyDown={blurOnEnter}
          placeholder="—"
          className="w-24 rounded-md border border-line px-2 py-1 tabular-nums outline-none focus:border-action"
        />
        <span aria-hidden className="text-ink-soft">
          ₸
        </span>
      </div>
      {product.notes.length > 0 && !product.confirmed && (
        <ul className="space-y-1 border-l-2 border-check bg-check-bg px-2.5 py-1.5 text-sm text-check">
          {product.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
        {product.confirmed ? (
          <>
            <span className="font-medium text-ok">✓ Confirmed</span>
            <button type="button" disabled={busy} onClick={() => void run(() => save({ confirmed: false }))} className="text-sm text-ink-soft underline-offset-2 hover:underline">
              Undo
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => save({ confirmed: true }))}
            className="rounded-md bg-action px-3 py-1.5 font-medium text-white hover:bg-action-dark disabled:opacity-70"
          >
            Confirm
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => window.confirm(`Remove “${product.localName}” from the shelf?`) && void run(remove)}
          className="text-sm text-ink-soft underline-offset-2 hover:underline"
        >
          Remove
        </button>
        {busy && <span className="text-sm text-ink-soft">Saving…</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-check">
          {error}
        </p>
      )}
    </div>
  );
}
