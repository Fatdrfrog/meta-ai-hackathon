import type { ApiChatMessage, ApiOrder, ShopProduct } from "@vitrina/server/api";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { chatApi, RequestError } from "../api.ts";
import { formatPrice, keepAmountsTogether } from "../format.ts";

const storageKey = (slug: string) => `vitrina-chat:${slug}`;

// The chat id only lets a buyer pick up where they left off; the page works without storage.
function readStoredId(slug: string): string | null {
  try {
    return localStorage.getItem(storageKey(slug));
  } catch {
    return null;
  }
}
function storeId(slug: string, id: string | null) {
  try {
    if (id) localStorage.setItem(storageKey(slug), id);
    else localStorage.removeItem(storageKey(slug));
  } catch {
    // Private mode or blocked storage: the chat just won't survive a reload.
  }
}

interface Pending {
  readonly text: string;
  readonly photoUrl: string | null;
}

export function Chat({
  slug,
  shopName,
  suggestions,
  prefill,
  onClose,
}: {
  slug: string;
  shopName: string;
  suggestions: readonly string[];
  /** Text to put in the message box, e.g. from a product's "Ask" button; `nonce` makes repeats count. */
  prefill?: { text: string; nonce: number };
  onClose?: () => void;
}) {
  const api = useMemo(() => chatApi(slug), [slug]);
  const inputId = useId();
  const photoId = useId();
  const [conversationId, setConversationId] = useState<string | null>(() => readStoredId(slug));
  const [messages, setMessages] = useState<readonly ApiChatMessage[]>([]);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const photoPreview = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);

  useEffect(() => () => void (photoPreview && URL.revokeObjectURL(photoPreview)), [photoPreview]);

  useEffect(() => {
    if (!conversationId) return;
    api.load(conversationId).then(
      (chat) => setMessages(chat.messages),
      () => {
        storeId(slug, null);
        setConversationId(null);
      },
    );
    // Loaded once per shop: later messages arrive with each reply.
  }, [api]);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    textBox.current?.focus();
  }, [prefill]);

  // Stay on the newest message, also when product photos finish loading and push it down, unless
  // the buyer has scrolled up to reread something.
  const following = useRef(true);
  const followBottom = () => {
    const el = log.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  };
  useEffect(followBottom, [messages, pending]);

  async function send(message: string, attached: File | null) {
    if ((!message.trim() && !attached) || pending) return;
    following.current = true;
    setError(null);
    const pendingPhotoUrl = attached ? URL.createObjectURL(attached) : null;
    setPending({ text: message.trim(), photoUrl: pendingPhotoUrl });
    setText("");
    setPhoto(null);
    try {
      const chat = await api.send({ conversationId, text: message.trim(), photo: attached });
      setConversationId(chat.conversationId);
      storeId(slug, chat.conversationId);
      setMessages((all) => [...all, ...chat.messages]);
    } catch (e) {
      setText(message);
      setPhoto(attached);
      setError(e instanceof RequestError ? e.message : "The message wasn't sent. Try again.");
    } finally {
      setPending(null);
      if (pendingPhotoUrl) URL.revokeObjectURL(pendingPhotoUrl);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text, photo);
  };
  const sendOnEnter = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(text, photo);
    }
  };

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold">Ask the shop</h2>
          <p className="truncate text-sm text-ink-soft">{shopName} answers in Kazakh, Russian or English</p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="ml-auto rounded-md px-2 py-1 text-ink-soft hover:bg-wall hover:text-ink" aria-label="Close the chat">
            ✕
          </button>
        )}
      </div>

      <div
        ref={log}
        role="log"
        aria-live="polite"
        aria-label="Chat with the shop"
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        onLoadCapture={followBottom}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 && !pending && (
          <div className="space-y-3">
            <p className="text-ink-soft">Ask about any product, or send a photo of what you’re looking for.</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => void send(s, null)} className="rounded-full border border-line px-3 py-1.5 text-sm hover:border-action hover:text-action">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (m.role === "buyer" ? <BuyerBubble key={m.id} text={m.text} photoUrl={m.photoUrl} /> : <SellerReply key={m.id} message={m} />))}
        {pending && (
          <>
            <BuyerBubble text={pending.text} photoUrl={pending.photoUrl} />
            <div className="mr-auto flex w-fit gap-1 rounded-2xl rounded-bl-sm bg-wall px-4 py-3" aria-label="The shop is typing">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 rounded-full bg-ink-soft motion-safe:animate-bounce" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </div>
          </>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-line p-3">
        {error && (
          <p role="alert" className="mb-2 text-sm text-check">
            {error}
          </p>
        )}
        {photoPreview && (
          <div className="mb-2 flex items-center gap-2">
            <img src={photoPreview} alt="Photo to send" className="size-12 rounded-md object-cover" />
            <button type="button" onClick={() => setPhoto(null)} className="text-sm text-ink-soft underline-offset-2 hover:underline">
              Remove photo
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            id={photoId}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              setPhoto(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <label
            htmlFor={photoId}
            title="Attach a photo"
            className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-md border border-line text-ink-soft hover:border-action hover:text-action has-[:focus-visible]:outline-3"
          >
            <span className="sr-only">Attach a photo</span>
            <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
          </label>
          <label htmlFor={inputId} className="sr-only">
            Message
          </label>
          <textarea
            ref={textBox}
            id={inputId}
            rows={1}
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={sendOnEnter}
            placeholder="Write a message"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-md border border-line px-3 py-2 outline-none focus:border-action"
          />
          <button
            type="submit"
            disabled={pending !== null || (!text.trim() && !photo)}
            className="h-10 shrink-0 rounded-md bg-action px-4 font-medium text-white hover:bg-action-dark disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function BuyerBubble({ text, photoUrl }: { text: string; photoUrl: string | null }) {
  return (
    <div className="ml-auto w-fit max-w-[85%] space-y-2 rounded-2xl rounded-br-sm bg-ink px-3.5 py-2 text-white">
      {photoUrl && <img src={photoUrl} alt="Your photo" className="max-h-48 rounded-lg" />}
      {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
    </div>
  );
}

function SellerReply({ message }: { message: ApiChatMessage }) {
  return (
    <div className="mr-auto max-w-[95%] space-y-2">
      <p className="w-fit whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-wall px-3.5 py-2">{keepAmountsTogether(message.text)}</p>
      {message.products.length > 0 && (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Products in this reply">
          {message.products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </ul>
      )}
      {message.order && <OrderReceipt order={message.order} />}
    </div>
  );
}

function ProductCard({ product }: { product: ShopProduct }) {
  const price = formatPrice(product.price, product.currency);
  return (
    <li className="w-28 shrink-0">
      <div className="relative grid aspect-square place-items-center border-b-4 border-shelf bg-wall p-2">
        <img src={product.imageUrl} alt="" className="max-h-full max-w-full object-contain drop-shadow-[0_6px_6px_rgba(27,36,64,0.2)]" />
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm leading-snug">{product.localName}</p>
      {price && <p className="font-display text-sm font-semibold">{price}</p>}
    </li>
  );
}

function OrderReceipt({ order }: { order: ApiOrder }) {
  return (
    <div className="w-fit min-w-56 border border-line border-l-4 border-l-ok bg-white px-3.5 py-2.5">
      <p className="font-medium text-ok">✓ Order placed</p>
      <ul className="mt-1.5 space-y-0.5 text-sm">
        {order.items.map((item) => (
          <li key={item.localName}>
            {item.localName} × {item.quantity}
            {item.price !== null && <span className="text-ink-soft">: {formatPrice(item.price * item.quantity, "KZT")}</span>}
          </li>
        ))}
      </ul>
      {order.total !== null && <p className="mt-1.5 font-display text-sm font-semibold">Total {formatPrice(order.total, "KZT")}</p>}
      <p className="mt-1 text-sm text-ink-soft">The shop will contact you at {order.buyerPhone}.</p>
    </div>
  );
}
