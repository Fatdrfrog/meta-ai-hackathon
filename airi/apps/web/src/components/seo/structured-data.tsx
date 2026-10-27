type StructuredData = Record<string, unknown>;

interface StructuredDataProps {
  data: StructuredData | StructuredData[];
}

/**
 * Component to inject JSON-LD structured data into the page
 * This helps search engines understand the content better
 */
export function StructuredData({ data }: StructuredDataProps) {
  const jsonLd = Array.isArray(data) ? data : [data];
  const serializeJsonLd = (item: StructuredData) =>
    JSON.stringify(item)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");

  return (
    <>
      {jsonLd.map((item, index) => (
        <script
          key={index}
          id={`structured-data-${index}`}
          type="application/ld+json"
          suppressHydrationWarning
        >
          {serializeJsonLd(item)}
        </script>
      ))}
    </>
  );
}
