import type { ApiOrder, ApiQuestion } from "@vitrina/server/api";
import { useState } from "react";
import { formatPrice } from "../format.ts";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function Orders({ orders }: { orders: readonly ApiOrder[] }) {
  if (orders.length === 0) return null;
  return (
    <section aria-labelledby="orders-heading">
      <h2 id="orders-heading" className="font-display text-xl font-semibold">
        Orders from the chat
      </h2>
      <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {orders.map((order) => (
          <li key={order.id} className="border border-line border-l-4 border-l-ok px-4 py-3">
            <p className="font-medium">{order.buyerName ?? "A buyer"}</p>
            <a href={`tel:${order.buyerPhone}`} className="text-action underline-offset-4 hover:underline">
              {order.buyerPhone}
            </a>
            <ul className="mt-2 space-y-0.5 text-sm">
              {order.items.map((item) => (
                <li key={item.localName}>
                  {item.localName} × {item.quantity}
                </li>
              ))}
            </ul>
            <p className="mt-2 flex items-baseline justify-between gap-3">
              <span className="font-display font-semibold">{order.total === null ? "Price to agree" : formatPrice(order.total, "KZT")}</span>
              <span className="text-sm text-ink-soft">{when(order.createdAt)}</span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Questions({ questions, onDone }: { questions: readonly ApiQuestion[]; onDone: (id: string, done: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (questions.length === 0) return null;
  const open = questions.filter((q) => !q.done).length;
  return (
    <section aria-labelledby="questions-heading">
      <h2 id="questions-heading" className="font-display text-xl font-semibold">
        Questions the assistant couldn’t answer
      </h2>
      <p className="mt-1 text-ink-soft">{open === 0 ? "All handled." : `${open} waiting for you. Reply to the buyer, then mark it done.`}</p>
      <ul className="mt-3 space-y-2">
        {questions.map((q) => (
          <li key={q.id} className={`flex flex-wrap items-start gap-x-4 gap-y-1 border px-4 py-3 ${q.done ? "border-line text-ink-soft" : "border-check bg-check-bg"}`}>
            <p className="min-w-0 flex-1 break-words">{q.question}</p>
            <span className="text-sm text-ink-soft">{when(q.createdAt)}</span>
            <button
              type="button"
              disabled={busy === q.id}
              onClick={() => {
                setBusy(q.id);
                void onDone(q.id, !q.done).finally(() => setBusy(null));
              }}
              className="text-sm font-medium text-action underline-offset-4 hover:underline disabled:opacity-60"
            >
              {q.done ? "Reopen" : "Mark done"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
