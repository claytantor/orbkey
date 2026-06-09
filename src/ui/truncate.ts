/**
 * Display-width-aware truncation. Secret keys and notes can contain wide
 * characters (CJK, emoji), so naive `String.slice(0, n)` over-counts columns
 * and breaks layout. These helpers measure in terminal columns via
 * `string-width` and append an ellipsis that itself fits the budget.
 */

import stringWidth from 'string-width';

const ELLIPSIS = '…';

/** A single display segment, optionally marked as a filter match for highlight. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into segments around every case-insensitive occurrence of
 * `needle`, marking the matched runs so the view can color them. Returns a
 * single non-match segment when the needle is empty or absent. Pure; operates on
 * the already-truncated display string so highlight never disagrees with what is
 * actually drawn.
 */
export function splitHighlight(text: string, needle: string): HighlightSegment[] {
  const n = needle.trim();
  if (!n) {
    return [{ text, match: false }];
  }
  const lowerText = text.toLowerCase();
  const lowerNeedle = n.toLowerCase();
  const segments: HighlightSegment[] = [];
  let i = 0;
  for (;;) {
    const at = lowerText.indexOf(lowerNeedle, i);
    if (at === -1) {
      if (i < text.length) {
        segments.push({ text: text.slice(i), match: false });
      }
      break;
    }
    if (at > i) {
      segments.push({ text: text.slice(i, at), match: false });
    }
    segments.push({ text: text.slice(at, at + n.length), match: true });
    i = at + n.length;
  }
  return segments.length > 0 ? segments : [{ text, match: false }];
}

/**
 * Hard-break a single token that is wider than `maxCols` into chunks that each
 * fit the budget, measured in terminal columns. Used by `wrapText` for words
 * with no internal break opportunity (long IDs, base64, URLs). Pure.
 */
function hardBreak(token: string, maxCols: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let used = 0;
  for (const ch of token) {
    const w = stringWidth(ch);
    // A single char wider than the whole budget still has to land somewhere;
    // emit it on its own line so we never loop forever.
    if (used + w > maxCols && cur !== '') {
      lines.push(cur);
      cur = '';
      used = 0;
    }
    cur += ch;
    used += w;
  }
  if (cur !== '') {
    lines.push(cur);
  }
  return lines;
}

/**
 * Word-wrap `text` to at most `width` terminal columns per line, measured via
 * `string-width` (NOT `.length`, which over-counts CJK/emoji). Breaks on spaces;
 * a word longer than `width` is hard-broken so no line ever exceeds the budget.
 * Existing newlines in `text` are honored as hard line breaks (blank lines are
 * preserved, so multi-paragraph notes keep their shape). Returns `[]` for empty
 * or whitespace-only input. Pure — used by DetailPane to COUNT and CAP lines for
 * vertical truncation, which Ink's `wrap="wrap"` can't expose.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) {
    return [];
  }
  if (text.trim() === '') {
    return [];
  }
  const out: string[] = [];
  // Normalize CRLF, then split on hard newlines so paragraphs are preserved.
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  for (const para of paragraphs) {
    // A blank line between paragraphs is meaningful; keep it.
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    const words = para.split(/[ \t]+/).filter((w) => w !== '');
    let line = '';
    let lineWidth = 0;
    for (const word of words) {
      const wordWidth = stringWidth(word);
      if (wordWidth > width) {
        // Flush the current line, then hard-break the over-long word.
        if (line !== '') {
          out.push(line);
          line = '';
          lineWidth = 0;
        }
        const chunks = hardBreak(word, width);
        // All but the last chunk are full lines; the last seeds the next line so
        // following words can still pack onto it.
        for (let i = 0; i < chunks.length - 1; i += 1) {
          out.push(chunks[i] ?? '');
        }
        const tail = chunks[chunks.length - 1] ?? '';
        line = tail;
        lineWidth = stringWidth(tail);
        continue;
      }
      // +1 for the joining space when the line is non-empty.
      const projected = line === '' ? wordWidth : lineWidth + 1 + wordWidth;
      if (projected > width) {
        out.push(line);
        line = word;
        lineWidth = wordWidth;
      } else {
        line = line === '' ? word : `${line} ${word}`;
        lineWidth = projected;
      }
    }
    out.push(line);
  }
  return out;
}

/** Truncate to at most `maxCols` terminal columns, appending `…` when cut. */
export function truncateEnd(text: string, maxCols: number): string {
  if (maxCols <= 0) {
    return '';
  }
  if (stringWidth(text) <= maxCols) {
    return text;
  }
  if (maxCols === 1) {
    return ELLIPSIS;
  }
  // Reserve one column for the ellipsis.
  const budget = maxCols - 1;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > budget) {
      break;
    }
    out += ch;
    used += w;
  }
  return out + ELLIPSIS;
}

/**
 * Truncate keeping the start and end, eliding the middle (good for ARNs / long
 * IDs where both ends are meaningful). Falls back to end-truncation for tiny
 * budgets.
 */
export function truncateMiddle(text: string, maxCols: number): string {
  if (maxCols <= 0) {
    return '';
  }
  const total = stringWidth(text);
  if (total <= maxCols) {
    return text;
  }
  if (maxCols <= 3) {
    return truncateEnd(text, maxCols);
  }
  const budget = maxCols - 1; // room for the ellipsis
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;

  const chars = [...text];
  let head = '';
  let headUsed = 0;
  for (const ch of chars) {
    const w = stringWidth(ch);
    if (headUsed + w > headBudget) {
      break;
    }
    head += ch;
    headUsed += w;
  }
  let tail = '';
  let tailUsed = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] ?? '';
    const w = stringWidth(ch);
    if (tailUsed + w > tailBudget) {
      break;
    }
    tail = ch + tail;
    tailUsed += w;
  }
  return head + ELLIPSIS + tail;
}
