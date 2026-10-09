/** HTML-escape a string to prevent injection. */
export function esc(str: string | undefined | null): string {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal, safe markdown renderer for HQ panels.
 * Escapes all HTML first, then applies formatting.
 */
export function renderMarkdown(md: string): string {
  const escaped = esc(md || "");
  const blocks: string[] = [];
  const tick = "`";
  const fence = "```";

  // Extract fenced code blocks
  const fenceRe = new RegExp(
    fence + "([a-zA-Z0-9_-]+)?\\n([\\s\\S]*?)" + fence,
    "g"
  );
  let text = escaped.replace(fenceRe, (_m, _lang, code) => {
    const idx = blocks.length;
    blocks.push(`<pre class="md-pre"><code>${code}</code></pre>`);
    return `@@MD_BLOCK_${idx}@@`;
  });

  const inlineCodeRe = new RegExp(tick + "([^" + tick + "]+)" + tick, "g");
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const boldRe = /\*\*([^*]+)\*\*/g;

  function inlineFormat(s: string): string {
    let out = String(s || "").replace(boldRe, "<strong>$1</strong>");
    out = out.replace(inlineCodeRe, '<code class="md-inline">$1</code>');
    out = out.replace(
      linkRe,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return out;
  }

  const lines = text.split(/\r?\n/);
  const html: string[] = [];
  let inUl = false;
  let inOl = false;
  let inQuote = false;

  function isTableSepLine(s: string): boolean {
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(s || "");
  }

  function splitTableRow(s: string): string[] {
    if (!s) return [];
    let row = String(s).trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|")) row = row.slice(0, -1);
    return row.split("|").map((c) => (c || "").trim());
  }

  function parseAlignments(sepLine: string): string[] {
    return splitTableRow(sepLine).map((c) => {
      const t = (c || "").trim();
      const left = t.startsWith(":");
      const right = t.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
  }

  function closeLists(): void {
    if (inUl) { html.push("</ul>"); inUl = false; }
    if (inOl) { html.push("</ol>"); inOl = false; }
  }
  function closeQuote(): void {
    if (inQuote) { html.push("</blockquote>"); inQuote = false; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Block placeholder
    const mBlock = line.match(/^@@MD_BLOCK_(\d+)@@$/);
    if (mBlock) {
      closeLists();
      closeQuote();
      const idx = parseInt(mBlock[1], 10);
      if (!isNaN(idx) && blocks[idx]) html.push(blocks[idx]);
      continue;
    }

    // Horizontal rule
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeLists(); closeQuote(); html.push("<hr>"); continue;
    }

    // Headings
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) { closeLists(); closeQuote(); html.push(`<h3>${inlineFormat(h3[1])}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { closeLists(); closeQuote(); html.push(`<h2>${inlineFormat(h2[1])}</h2>`); continue; }
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) { closeLists(); closeQuote(); html.push(`<h1>${inlineFormat(h1[1])}</h1>`); continue; }

    // Tables
    if (line && line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSepLine(lines[i + 1])) {
      closeLists(); closeQuote();
      const headerCells = splitTableRow(line);
      const alignments = parseAlignments(lines[i + 1]);
      i += 1;
      const rows: string[][] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!next || /^\s*$/.test(next)) break;
        if (next.indexOf("|") === -1) break;
        if (isTableSepLine(next)) break;
        rows.push(splitTableRow(next));
        i += 1;
      }
      let table = '<table class="md-table"><thead><tr>';
      for (let c = 0; c < headerCells.length; c++) {
        const align = alignments[c] ? ` style="text-align:${alignments[c]}"` : "";
        table += `<th${align}>${inlineFormat(headerCells[c] || "")}</th>`;
      }
      table += "</tr></thead>";
      if (rows.length > 0) {
        table += "<tbody>";
        for (const row of rows) {
          table += "<tr>";
          for (let c = 0; c < headerCells.length; c++) {
            const cell = row[c] || "";
            const align = alignments[c] ? ` style="text-align:${alignments[c]}"` : "";
            table += `<td${align}>${inlineFormat(cell)}</td>`;
          }
          table += "</tr>";
        }
        table += "</tbody>";
      }
      table += "</table>";
      html.push(table);
      continue;
    }

    // Blockquote
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeLists();
      if (!inQuote) { html.push("<blockquote>"); inQuote = true; }
      html.push(`<div>${inlineFormat(q[1])}</div>`);
      continue;
    } else {
      closeQuote();
    }

    // Unordered list
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      if (inOl) { html.push("</ol>"); inOl = false; }
      if (!inUl) { html.push("<ul>"); inUl = true; }
      html.push(`<li>${inlineFormat(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) { html.push("</ul>"); inUl = false; }
      if (!inOl) { html.push("<ol>"); inOl = true; }
      html.push(`<li>${inlineFormat(ol[1])}</li>`);
      continue;
    }

    // Empty line
    if (!line || /^\s*$/.test(line)) {
      closeLists(); closeQuote(); html.push("<br>"); continue;
    }

    // Paragraph
    closeLists(); closeQuote();
    html.push(`<p>${inlineFormat(line)}</p>`);
  }

  closeLists();
  closeQuote();

  return '<div class="md">' + html.join("") + "</div>";
}
