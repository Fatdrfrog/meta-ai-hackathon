export function observeElementResize(
  element: Element,
  callback: () => void
): () => void {
  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }

  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      callback();
    });
  };

  const observer = new ResizeObserver(schedule);
  observer.observe(element);

  return () => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
    }
    observer.disconnect();
  };
}
