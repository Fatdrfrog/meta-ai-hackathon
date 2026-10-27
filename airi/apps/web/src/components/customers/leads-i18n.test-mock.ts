import enCatalog from "../../../messages/customers/en/page.json";

type MessageNode = string | { [key: string]: MessageNode };

function lookupLeadsMessage(
  key: string,
  values?: Record<string, string | number>
): string {
  const found = key.split(".").reduce<MessageNode | undefined>(
    (current, part) =>
      current && typeof current === "object" ? current[part] : undefined,
    enCatalog.LeadsPage as MessageNode
  );
  if (typeof found !== "string") return key;
  return found
    .replace(
      /\{(\w+), plural, one \{([^}]*)\}(?: few \{([^}]*)\})? other \{([^}]*)\}\}/g,
      (_, name: string, one: string, few: string | undefined, other: string) => {
        const count = Number(values?.[name] ?? 0);
        const picked =
          count === 1 ? one : few && count >= 2 && count <= 4 ? few : other;
        return picked.replace(/#/g, String(count));
      }
    )
    .replace(/\{(\w+)\}/g, (_, name: string) =>
      values && name in values ? String(values[name]) : `{${name}}`
    );
}

export function mockLeadsTranslations() {
  return {
    useTranslations: () => lookupLeadsMessage,
  };
}
