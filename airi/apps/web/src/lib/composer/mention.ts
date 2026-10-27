export type ActiveMention = {
  start: number;
  end: number;
  query: string;
};

export function getActiveMention(
  value: string,
  caret: number
): ActiveMention | null {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
  if (!match || match.index === undefined) return null;
  const prefixLength = match[1]?.length || 0;
  const start = match.index + prefixLength;
  return {
    start,
    end: caret,
    query: match[2] || "",
  };
}

export function mentionTokenFromLabel(label: string): string {
  return `@${label.replace(/\s+/g, " ").trim()}`;
}

export function replaceActiveMention(params: {
  value: string;
  mention: ActiveMention | null;
  token: string;
}): { value: string; caret: number } {
  const token = params.token.trim();
  if (!token) {
    return { value: params.value, caret: params.value.length };
  }

  if (params.mention) {
    const nextValue =
      params.value.slice(0, params.mention.start) +
      token +
      " " +
      params.value.slice(params.mention.end);
    return {
      value: nextValue,
      caret: params.mention.start + token.length + 1,
    };
  }

  const prefix = params.value.trimEnd();
  const nextValue = prefix ? `${prefix} ${token} ` : `${token} `;
  return { value: nextValue, caret: nextValue.length };
}

export function filterMentionsStillInText<T>(params: {
  value: string;
  items: T[];
  getToken: (item: T) => string;
}): T[] {
  return params.items.filter(item =>
    params.value.includes(params.getToken(item))
  );
}

export function afterNextPaint(callback: () => void): void {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    window.requestAnimationFrame(callback);
    return;
  }
  queueMicrotask(callback);
}
