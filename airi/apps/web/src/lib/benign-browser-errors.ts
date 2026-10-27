const BENIGN_RESIZE_OBSERVER_MESSAGE =
  /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/;

// Translator-induced "not a child of this node" errors are deliberately not
// listed: installTranslatedDomGuards prevents them, so one that still reaches
// PostHog is a real crash.
const BENIGN_BROWSER_ERROR_MESSAGES = [BENIGN_RESIZE_OBSERVER_MESSAGE];

export function isBenignResizeObserverMessage(message: string): boolean {
  return BENIGN_RESIZE_OBSERVER_MESSAGE.test(message);
}

export function isBenignBrowserErrorMessage(message: string): boolean {
  return BENIGN_BROWSER_ERROR_MESSAGES.some(pattern => pattern.test(message));
}

function getExceptionMessages(properties: Record<string, unknown>): string[] {
  const messages: string[] = [];

  // Present when an exception is captured manually with an explicit message.
  const directMessage = properties.$exception_message;
  if (typeof directMessage === "string") {
    messages.push(directMessage);
  }

  // posthog-js autocapture writes each exception as an `$exception_list` item
  // whose message lives under `value`.
  const exceptionList = properties.$exception_list;
  if (Array.isArray(exceptionList)) {
    for (const item of exceptionList) {
      if (!item || typeof item !== "object") continue;
      const message = (item as Record<string, unknown>).value;
      if (typeof message === "string") {
        messages.push(message);
      }
    }
  }

  return messages;
}

export function shouldDropBenignExceptionEvent(event: {
  event?: string;
  properties?: Record<string, unknown>;
}): boolean {
  if (event.event !== "$exception") return false;

  return getExceptionMessages(event.properties ?? {}).some(message =>
    isBenignBrowserErrorMessage(message)
  );
}

const TRANSLATED_DOM_GUARDS_INSTALLED = Symbol.for(
  "airi.translatedDomGuardsInstalled"
);

let translatedDomGuardWarned = false;

function warnTranslatedDomGuardOnce(method: string): void {
  if (translatedDomGuardWarned) return;
  translatedDomGuardWarned = true;
  console.warn(
    `[dom] ${method} skipped a node a page translator replaced; the page kept rendering`
  );
}

// Chrome's page translator (and similar extensions) swaps the text nodes React
// still tracks for its own <font> wrappers. React's next removeChild or
// insertBefore on a swapped node throws NotFoundError, and the route error
// boundary then replaces the whole page with "This page couldn't load".
// Only calls that would throw change behavior: a node React wants gone is
// removed from wherever it now lives, and a node whose anchor is gone is
// appended to the parent instead.
export function installTranslatedDomGuards(): void {
  if (typeof Node === "undefined") return;

  const proto = Node.prototype as Node & {
    [TRANSLATED_DOM_GUARDS_INSTALLED]?: true;
  };
  if (proto[TRANSLATED_DOM_GUARDS_INSTALLED]) return;
  proto[TRANSLATED_DOM_GUARDS_INSTALLED] = true;

  const removeChild = proto.removeChild;
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child instanceof Node && child.parentNode !== this) {
      warnTranslatedDomGuardOnce("removeChild");
      child.parentNode?.removeChild(child);
      return child;
    }
    return removeChild.call(this, child) as T;
  };

  const insertBefore = proto.insertBefore;
  proto.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    child: Node | null
  ): T {
    if (child instanceof Node && child.parentNode !== this) {
      warnTranslatedDomGuardOnce("insertBefore");
      return insertBefore.call(this, node, null) as T;
    }
    return insertBefore.call(this, node, child) as T;
  };
}

export function installBenignBrowserErrorHandlers(): void {
  if (typeof window === "undefined") return;

  window.addEventListener(
    "error",
    event => {
      if (isBenignResizeObserverMessage(event.message)) {
        event.stopImmediatePropagation();
      }
    },
    true
  );
}
