// jsdom lacks matchMedia and ResizeObserver, which Radix, cmdk and the
// responsive hooks call. These install inert stand-ins; call them where the
// suite used to assign its own (module scope, beforeAll or beforeEach).

/**
 * Defines window.matchMedia as a jest.fn whose lists report
 * matches(query) (false by default) and whose listener methods are jest.fn.
 * Returns the mock so tests can assert on the queries.
 */
export function installMatchMedia(
  matches: (query: string) => boolean = () => false
) {
  const matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
  return matchMedia;
}

export class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** Sets globalThis.ResizeObserver to an observer that never reports. */
export function installResizeObserver() {
  globalThis.ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
}
