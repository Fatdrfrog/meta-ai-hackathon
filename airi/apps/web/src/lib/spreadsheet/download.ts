/** Saves text as a file in the browser, e.g. a CSV export or a template. */
export function downloadTextFile({
  filename,
  text,
  mimeType,
}: {
  filename: string;
  text: string;
  mimeType: string;
}): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
