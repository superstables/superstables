/**
 * The embed URL for a Tally form, built from fixed values only. Tally fills hidden fields
 * from the query string of the embed URL (tally.so/embed/ID).
 * Only the keys below are forwarded, with short plain values; the host page's own query
 * string never is (the embed sets `src` explicitly, so the widget leaves the URL alone).
 */

export const TALLY_ORIGIN = "https://tally.so";

const CONTEXT_KEYS = ["source", "environment", "page", "surface", "client_version", "build_version"] as const;
export type TallyContextKey = (typeof CONTEXT_KEYS)[number];
export type TallyContext = Partial<Record<TallyContextKey, string>>;

/** Letters, digits, dot, underscore, slash and dash; at most 64 characters. */
const SAFE_VALUE = /^[A-Za-z0-9/][A-Za-z0-9._/-]{0,63}$/;

/** The allowlisted hidden-field pairs in a fixed order; anything else is dropped. */
export function tallyContextParams(context: TallyContext): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of CONTEXT_KEYS) {
    const value = context[key];
    if (typeof value === "string" && SAFE_VALUE.test(value)) params.set(key, value);
  }
  return params;
}

/** Documented embed options: left-aligned, no form title (the page has the heading), transparent, resized to fit. */
const EMBED_OPTIONS: Record<string, string> = { alignLeft: "1", hideTitle: "1", transparentBackground: "1", dynamicHeight: "1" };

/** The iframe src for the standard embed. */
export function tallyEmbedUrl(formId: string, context: TallyContext): string {
  const params = new URLSearchParams(EMBED_OPTIONS);
  tallyContextParams(context).forEach((value, key) => params.set(key, value));
  return `${TALLY_ORIGIN}/embed/${encodeURIComponent(formId)}?${params.toString()}`;
}
