function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(value) {
  const htmlTokens = [];
  const valueWithPlaceholders = String(value || "").replace(
    /<\/?[a-z][^>]*>/gi,
    tag => {
      const token = `\u0000HTML_${htmlTokens.length}\u0000`;
      htmlTokens.push(tag);
      return token;
    }
  );

  return escapeHtml(valueWithPlaceholders)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]+)"|&quot;([^&]+)&quot;))?\)/g,
      (_match, alt, src, quotedTitle, escapedTitle) => {
        const title = quotedTitle || escapedTitle;
        return `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ""}>`;
      }
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\u0000HTML_(\d+)\u0000/g, (_match, index) => htmlTokens[index]);
}

function lexInline(value) {
  const text = String(value || "");
  const tokens = [];
  const pattern = /(\*\*([\s\S]+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        type: "text",
        raw: text.slice(lastIndex, match.index),
        text: text.slice(lastIndex, match.index),
      });
    }
    if (match[2]) {
      tokens.push({
        type: "strong",
        raw: match[0],
        text: match[2],
        tokens: [{ type: "text", raw: match[2], text: match[2] }],
      });
    } else if (match[3]) {
      tokens.push({ type: "codespan", raw: match[0], text: match[3] });
    } else if (match[4] && match[5]) {
      tokens.push({
        type: "link",
        raw: match[0],
        href: match[5],
        text: match[4],
        tokens: [{ type: "text", raw: match[4], text: match[4] }],
      });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({
      type: "text",
      raw: text.slice(lastIndex),
      text: text.slice(lastIndex),
    });
  }

  return tokens;
}

function splitTableRow(row) {
  return String(row || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(cell => cell.trim());
}

function isTableSeparator(row) {
  const cells = splitTableRow(row);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function renderTable(block) {
  const lines = String(block || "")
    .trim()
    .split(/\n/)
    .filter(line => line.trim());

  if (lines.length < 3 || !isTableSeparator(lines[1])) {
    return null;
  }

  const headers = splitTableRow(lines[0]);
  const rows = lines.slice(2).map(splitTableRow);

  return [
    "<table>",
    "<thead>",
    "<tr>",
    ...headers.map(header => `<th>${renderInline(header)}</th>`),
    "</tr>",
    "</thead>",
    "<tbody>",
    ...rows.flatMap(row => [
      "<tr>",
      ...row.map(cell => `<td>${renderInline(cell)}</td>`),
      "</tr>",
    ]),
    "</tbody></table>",
  ].join("\n");
}

function renderList(block) {
  const lines = String(block || "")
    .trim()
    .split(/\n/)
    .filter(line => line.trim());
  const ordered = lines.every(line => /^\s*\d+[.)]\s+/.test(line));
  const unordered = lines.every(line => /^\s*[-*]\s+/.test(line));

  if (!ordered && !unordered) {
    return null;
  }

  const tag = ordered ? "ol" : "ul";
  const itemPattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
  const items = lines.map(line => {
    const text = line.replace(itemPattern, "");
    const task = unordered ? text.match(/^\[([ xX])\]\s+([\s\S]+)$/) : null;

    if (task) {
      const checked = task[1].toLowerCase() === "x" ? ' checked=""' : "";
      return `<li><input${checked} disabled="" type="checkbox"> ${renderInline(task[2])}</li>`;
    }

    return `<li>${renderInline(text)}</li>`;
  });

  return [`<${tag}>`, ...items, `</${tag}>`].join("\n");
}

function renderCodeBlock(block) {
  const codeBlock = String(block || "").match(
    /^```([a-z0-9_-]+)?\n([\s\S]*)\n```$/i
  );
  if (!codeBlock) {
    return null;
  }

  const language = codeBlock[1] ? ` class="language-${codeBlock[1]}"` : "";
  return `<pre><code${language}>${escapeHtml(codeBlock[2])}\n</code></pre>`;
}

function parse(markdown) {
  const blocks = String(markdown || "")
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean);

  return blocks
    .map(block => {
      const htmlBlock = block.match(/^\s*<\/?[a-z][^>]*>/i);
      if (htmlBlock) {
        return block;
      }

      const table = renderTable(block);
      if (table) {
        return table;
      }

      const codeBlock = renderCodeBlock(block);
      if (codeBlock) {
        return codeBlock;
      }

      if (/^\s*(?:---|\*\*\*|___)\s*$/.test(block)) {
        return "<hr>";
      }

      if (block.split(/\n/).every(line => /^\s*>\s?/.test(line))) {
        const inner = block.replace(/^\s*>\s?/gm, "");
        return `<blockquote>\n${parse(inner)}\n</blockquote>`;
      }

      const list = renderList(block);
      if (list) {
        return list;
      }

      const heading = block.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        return `<h${level}>${renderInline(heading[2])}</h${level}>`;
      }
      return `<p>${renderInline(block).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

function lex(markdown) {
  const blocks = String(markdown || "")
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean);

  return blocks.map(block => {
    const heading = block.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      return {
        type: "heading",
        depth: heading[1].length,
        text: heading[2],
        tokens: lexInline(heading[2]),
      };
    }

    const lines = block.split(/\n/);
    const ordered = lines.every(line => /^\s*\d+[.)]\s+/.test(line));
    const unordered = lines.every(line => /^\s*[-*]\s+/.test(line));
    if (ordered || unordered) {
      return {
        type: "list",
        ordered,
        items: lines.map(line => {
          const text = line.replace(
            ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/,
            ""
          );
          return {
            type: "list_item",
            text,
            tokens: [
              {
                type: "text",
                text,
                tokens: lexInline(text),
              },
            ],
          };
        }),
      };
    }

    return {
      type: "paragraph",
      text: block,
      tokens: lexInline(block),
    };
  });
}

module.exports = {
  marked: { parse, lexer: lex },
  Lexer: { lex, lexInline },
  parse,
};
