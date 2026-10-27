export async function postConnectorJson<TResponse>(
  url: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as TResponse) : ({} as TResponse);
  if (!response.ok) {
    throw new Error(
      `WhatsApp call connector returned HTTP ${response.status}: ${text.slice(
        0,
        500,
      )}`,
    );
  }
  return parsed;
}
