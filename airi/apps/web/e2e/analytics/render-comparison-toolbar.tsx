import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { DashboardToolbar } from "@/components/dashboard/dashboard-toolbar";
import { MetricCard } from "@/components/dashboard/section-cards";
import { Card, CardContent } from "@/components/ui/card";

// This helper renders production components; it does not recreate their markup.
// Its separate Node process avoids Playwright's component-testing transform.
const noop = () => {};
const toolbars: Record<string, string> = {};
for (const locale of ["en", "ru", "kz"] as const) {
  const messages = {
    ...JSON.parse(
      readFileSync(path.join(process.cwd(), `messages/${locale}.json`), "utf8")
    ),
    ...JSON.parse(
      readFileSync(
        path.join(process.cwd(), `messages/panel/${locale}/page.json`),
        "utf8"
      )
    ),
  };
  toolbars[locale] = renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="Asia/Qyzylorda"
    >
      <div className="analytics-brand-theme">
        <DashboardToolbar
          dateRange={{ preset: "30d", from: null, to: null }}
          filters={{
            channels: [],
            categories: [],
            internalLabels: [],
            managerIds: [],
          }}
          options={{
            channels: [],
            categories: [],
            internalLabels: [],
            managers: [],
          }}
          presets={[]}
          comparisonAvailable
          comparisonEnabled
          comparisonPeriod={null}
          exportDisabled
          onDateRangeChange={noop}
          onComparisonChange={noop}
          onFiltersChange={noop}
          onSavePreset={noop}
          onApplyPreset={noop}
          onDeletePreset={noop}
          onExport={noop}
        />
        <section className="mt-6 max-w-sm">
          <MetricCard
            workspaceId="contrast-workspace"
            comparisonEnabled={false}
            stat={{
              id: "new",
              label: messages.SectionCards.metrics.new,
              value: "42",
              comparison: null,
              insight: "",
            }}
          />
        </section>
        <Card data-chart-palette className="mt-6 max-w-sm">
          <CardContent>
            {/* SVG marks exercise the actual scoped chart tokens on a canonical
                card surface without reproducing a production chart's behavior. */}
            <svg viewBox="0 0 240 80" aria-hidden="true" className="w-full">
              {[1, 2, 3].map((token, index) => (
                <rect
                  key={token}
                  data-brand-chart={token}
                  x={index * 80 + 8}
                  y={8}
                  width={64}
                  height={64}
                  fill={`var(--chart-${token})`}
                />
              ))}
            </svg>
          </CardContent>
        </Card>
      </div>
    </NextIntlClientProvider>
  );
}
process.stdout.write(JSON.stringify(toolbars));
