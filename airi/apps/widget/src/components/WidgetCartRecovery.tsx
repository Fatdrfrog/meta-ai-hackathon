import type { CommerceCartSummary } from "@icecore/shared/types/commerce-tracking";
import { useEffect, useState } from "preact/hooks";
import type { WidgetCommerce, WidgetCommerceSnapshot } from "../lib/commerce";

type Props = {
  commerce: WidgetCommerce;
  locale?: string;
};

const COPY = {
  en: {
    eyebrow: "Your cart",
    cart: "Cart ready to continue",
    checkout: "Checkout ready to continue",
    items: (count: number) => `${count} ${count === 1 ? "item" : "items"}`,
    consent:
      "I agree to receive cart reminders and other offers from this business on WhatsApp.",
    action: "Send my cart to WhatsApp",
    loading: "Preparing WhatsApp…",
    error: "We could not prepare your WhatsApp cart. Try again.",
    retry: "Try again",
    dismiss: "Dismiss cart recovery",
    open: "Open WhatsApp and send",
  },
  ru: {
    eyebrow: "Ваша корзина",
    cart: "Корзина готова к продолжению",
    checkout: "Оформление готово к продолжению",
    items: (count: number) => `${count} товар${count === 1 ? "" : "ов"}`,
    consent:
      "Я согласен получать в WhatsApp напоминания о корзине и другие предложения от этой компании.",
    action: "Отправить корзину в WhatsApp",
    loading: "Подготавливаем WhatsApp…",
    error: "Не удалось подготовить корзину для WhatsApp. Повторите попытку.",
    retry: "Повторить",
    dismiss: "Закрыть возврат к корзине",
    open: "Открыть WhatsApp и отправить",
  },
  kz: {
    eyebrow: "Себетіңіз",
    cart: "Себет жалғастыруға дайын",
    checkout: "Рәсімдеу жалғастыруға дайын",
    items: (count: number) => `${count} тауар`,
    consent:
      "Осы компаниядан WhatsApp арқылы себет туралы еске салулар мен басқа ұсыныстар алуға келісемін.",
    action: "Себетімді WhatsApp-қа жіберу",
    loading: "WhatsApp дайындалуда…",
    error: "WhatsApp себетін дайындау мүмкін болмады. Қайта көріңіз.",
    retry: "Қайталау",
    dismiss: "Себетке қайтаруды жабу",
    open: "WhatsApp ашып, жіберу",
  },
  uz: {
    eyebrow: "Savatingiz",
    cart: "Savatni davom ettirish mumkin",
    checkout: "Buyurtmani davom ettirish mumkin",
    items: (count: number) => `${count} ta mahsulot`,
    consent:
      "Ushbu kompaniyadan WhatsApp orqali savat eslatmalari va boshqa takliflarni olishga roziman.",
    action: "Savatimni WhatsApp’ga yuborish",
    loading: "WhatsApp tayyorlanmoqda…",
    error: "WhatsApp savatini tayyorlab bo‘lmadi. Qayta urinib ko‘ring.",
    retry: "Qayta urinish",
    dismiss: "Savatni tiklashni yopish",
    open: "WhatsApp’ni ochish va yuborish",
  },
} as const;

function normalizeLocale(locale?: string): keyof typeof COPY {
  const language = locale?.trim().toLowerCase().split(/[-_]/)[0];
  return language === "ru" || language === "kz" || language === "uz"
    ? language
    : "en";
}

export function selectActiveCommerceCart(
  carts: CommerceCartSummary[]
): CommerceCartSummary | null {
  return (
    carts.find(
      cart => cart.status === "checkout" && cart.itemCount > 0 && !cart.linked
    ) ??
    carts.find(
      cart => cart.status === "cart" && cart.itemCount > 0 && !cart.linked
    ) ??
    null
  );
}

export function WidgetCartRecovery({ commerce, locale }: Props) {
  const [snapshot, setSnapshot] = useState<WidgetCommerceSnapshot>(() =>
    commerce.getSnapshot()
  );
  const [dismissedCartId, setDismissedCartId] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [isCreatingHandoff, setIsCreatingHandoff] = useState(false);
  const [handoffError, setHandoffError] = useState(false);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);

  useEffect(() => commerce.subscribe(setSnapshot), [commerce]);

  const cart = selectActiveCommerceCart(snapshot.carts);
  const copy = COPY[normalizeLocale(locale)];

  useEffect(() => {
    setConsented(false);
    setHandoffError(false);
    setHandoffUrl(null);
  }, [cart?.cartId]);

  if (
    snapshot.enabled !== true ||
    !cart ||
    dismissedCartId === cart.cartId
  ) {
    return null;
  }

  const amount = new Intl.NumberFormat(normalizeLocale(locale), {
    style: "currency",
    currency: cart.currency,
    maximumFractionDigits: 2,
  }).format(cart.total);

  const createHandoff = async () => {
    if (!consented || isCreatingHandoff) return;
    setIsCreatingHandoff(true);
    setHandoffError(false);
    setHandoffUrl(null);
    try {
      const url = await commerce.createHandoff(
        cart.cartId,
        normalizeLocale(locale)
      );
      setHandoffUrl(url);
      try {
        window.open(url, "_blank", "noopener,noreferrer");
      } catch {
        // The explicit link below remains available if automatic opening fails.
      }
    } catch {
      setHandoffError(true);
    } finally {
      setIsCreatingHandoff(false);
    }
  };

  return (
    <aside
      aria-label={copy.eyebrow}
      className="fixed bottom-[88px] right-4 z-[999998] w-[calc(100vw-2rem)] max-w-[360px] rounded-2xl border border-black/10 bg-white p-4 text-[#1f2937] shadow-[0_18px_50px_rgba(15,23,42,0.18)] dark:border-white/10 dark:bg-[#171717] dark:text-[#f5f5f5]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#6b7280] dark:text-[#a3a3a3]">
            {copy.eyebrow}
          </p>
          <h2 className="mt-1 text-[15px] font-semibold leading-5">
            {cart.status === "checkout" ? copy.checkout : copy.cart}
          </h2>
          <p className="mt-1 truncate text-[13px] text-[#6b7280] dark:text-[#a3a3a3]">
            {copy.items(cart.itemCount)} · {amount}
          </p>
        </div>
        <button
          type="button"
          aria-label={copy.dismiss}
          onClick={() => setDismissedCartId(cart.cartId)}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-xl leading-none text-[#6b7280] transition hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--icecore-primary)] dark:text-[#a3a3a3] dark:hover:bg-white/10"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl bg-black/[0.035] p-3 text-[12px] leading-[1.45] dark:bg-white/[0.06]">
        <input
          type="checkbox"
          checked={consented}
          onChange={event => {
            setConsented(event.currentTarget.checked);
            setHandoffError(false);
          }}
          className="mt-0.5 size-4 shrink-0 accent-[var(--icecore-primary)]"
        />
        <span>{copy.consent}</span>
      </label>

      <button
        type="button"
        disabled={!consented || isCreatingHandoff}
        onClick={() => void createHandoff()}
        className="mt-3 flex min-h-11 w-full items-center justify-center rounded-xl border-0 bg-[var(--icecore-primary)] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--icecore-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isCreatingHandoff ? copy.loading : copy.action}
      </button>

      {handoffUrl ? (
        <div className="mt-3 text-[12px] leading-5">
          <a
            href={handoffUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--icecore-primary)]"
          >
            {copy.open}
          </a>
        </div>
      ) : handoffError ? (
        <div role="alert" className="mt-3 text-[12px] leading-5 text-[#b42318] dark:text-[#fda29b]">
          <p>{copy.error}</p>
          <button
            type="button"
            onClick={() => void createHandoff()}
            className="mt-1 min-h-9 border-0 bg-transparent p-0 font-semibold text-inherit underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--icecore-primary)]"
          >
            {copy.retry}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
