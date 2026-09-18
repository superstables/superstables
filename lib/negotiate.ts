// Accept media ranges and quality values for content pages and MCP.

type Range = { type: string; subtype: string; q: number; index: number };
type Match = { q: number; explicit: boolean; index: number };

function parseAccept(header: string | null): Range[] {
  if (!header) return [];
  const out: Range[] = [];
  header.split(",").forEach((part, index) => {
    const [range = "", ...params] = part.trim().split(";");
    const [type, subtype] = range.trim().toLowerCase().split("/");
    if (!type || !subtype) return;
    let q = 1;
    for (const p of params) {
      const eq = p.indexOf("=");
      if (eq === -1 || p.slice(0, eq).trim().toLowerCase() !== "q") continue;
      const n = Number(p.slice(eq + 1).trim());
      q = Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
    }
    out.push({ type, subtype, q, index });
  });
  return out;
}

/** Quality a client gives one concrete media type: the most specific matching range wins. */
function quality(ranges: Range[], type: string, subtype: string): Match | null {
  let best: (Match & { rank: number }) | null = null;
  for (const r of ranges) {
    let rank: number;
    if (r.type === type && r.subtype === subtype) rank = 3;
    else if (r.type === type && r.subtype === "*") rank = 2;
    else if (r.type === "*" && r.subtype === "*") rank = 1;
    else continue;
    if (!best || rank > best.rank) best = { q: r.q, explicit: rank === 3, index: r.index, rank };
  }
  return best;
}

/**
 * True when the client would rather have text/markdown than text/html.
 * Markdown has to be named explicitly with a non-zero quality (a bare wildcard means "HTML is fine")
 * and must not rank below HTML. On an equal quality an explicit type beats a wildcard, and between
 * two explicit types the one listed first wins. No Accept header, or nothing acceptable, means HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  const ranges = parseAccept(accept);
  const md = quality(ranges, "text", "markdown");
  if (!md || !md.explicit || md.q <= 0) return false;
  const html = quality(ranges, "text", "html");
  if (!html || html.q <= 0) return true;
  if (md.q !== html.q) return md.q > html.q;
  if (md.explicit !== html.explicit) return md.explicit;
  return md.index < html.index;
}

/** Whether a response type is permitted, including wildcard ranges and explicit exclusions. */
export function acceptsMediaType(accept: string | null, type: string, subtype: string): boolean {
  if (!accept?.trim()) return true;
  return (quality(parseAccept(accept), type, subtype)?.q ?? 0) > 0;
}
