// next-intl 4 ships ESM only and next/jest does not transform node_modules, so
// any suite that renders a translated shared component (ui/select, for one)
// would fail to import it. This stub returns message keys, like the per-file
// mocks; a suite's own jest.mock("next-intl", ...) still takes precedence.

function createTranslator() {
  const t = key => key;
  t.rich = key => key;
  t.markup = key => key;
  t.raw = key => key;
  t.has = () => true;
  return t;
}

function createFormatter({ locale = "en", timeZone = "UTC" } = {}) {
  return {
    number: (value, options) =>
      new Intl.NumberFormat(locale, options).format(value),
    dateTime: (value, options) =>
      new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(value),
    dateTimeRange: (start, end, options) =>
      new Intl.DateTimeFormat(locale, { timeZone, ...options }).formatRange(
        start,
        end
      ),
    relativeTime: (value, now) => {
      const base =
        now instanceof Date || typeof now === "number"
          ? now
          : (now?.now ?? Date.now());
      const seconds = Math.round(
        (new Date(value).getTime() - new Date(base).getTime()) / 1000
      );
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
        seconds,
        "second"
      );
    },
    list: (value, options) =>
      new Intl.ListFormat(locale, options).format(value),
  };
}

function Provider({ children }) {
  return children ?? null;
}

module.exports = {
  __esModule: true,
  createFormatter,
  createTranslator,
  hasLocale: (locales, locale) => locales.includes(locale),
  IntlProvider: Provider,
  NextIntlClientProvider: Provider,
  useExtracted: () => createTranslator(),
  useFormatter: () => createFormatter(),
  useLocale: () => "en",
  useMessages: () => ({}),
  useNow: () => new Date(),
  useTimeZone: () => "UTC",
  useTranslations: () => createTranslator(),
};
