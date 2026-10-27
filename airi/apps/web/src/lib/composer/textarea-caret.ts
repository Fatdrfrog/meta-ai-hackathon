/**
 * Approximate caret pixel offset inside a textarea (mirror-div technique).
 * Used to anchor @-pickers near the typed "@".
 */

export type TextareaCaretOffset = {
  top: number;
  left: number;
  height: number;
};

export function getTextareaCaretOffset(
  element: HTMLTextAreaElement,
  position: number
): TextareaCaretOffset {
  const style = window.getComputedStyle(element);
  const mirror = document.createElement("div");
  const properties = [
    "direction",
    "boxSizing",
    "width",
    "height",
    "overflowX",
    "overflowY",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderStyle",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontStyle",
    "fontVariant",
    "fontWeight",
    "fontStretch",
    "fontSize",
    "fontSizeAdjust",
    "lineHeight",
    "fontFamily",
    "textAlign",
    "textTransform",
    "textIndent",
    "textDecoration",
    "letterSpacing",
    "wordSpacing",
    "tabSize",
    "MozTabSize",
    "whiteSpace",
    "wordBreak",
    "wordWrap",
  ] as const;

  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflow = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  for (const prop of properties) {
    const value = style.getPropertyValue(
      prop.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
    );
    if (value) {
      mirror.style.setProperty(
        prop.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`),
        value
      );
    } else {
      const fallback = style[prop as keyof CSSStyleDeclaration];
      if (typeof fallback === "string" && fallback) {
        (mirror.style as unknown as Record<string, string>)[prop] = fallback;
      }
    }
  }

  mirror.style.width = `${element.clientWidth}px`;

  const text = element.value.slice(0, Math.max(0, position));
  mirror.textContent = text;
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const top = marker.offsetTop - element.scrollTop;
  const left = marker.offsetLeft - element.scrollLeft;
  const lineHeight =
    Number.parseFloat(style.lineHeight) ||
    Number.parseFloat(style.fontSize) * 1.4 ||
    20;
  document.body.removeChild(mirror);

  return { top, left, height: lineHeight };
}
