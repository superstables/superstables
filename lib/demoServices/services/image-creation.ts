// Image creation: a prepared image for one of three fixed briefs. The assets are hand-drawn
// SVGs served from public/demo/services; the paid body links to the file rather than
// embedding it, and nothing here renders anything. The brand is fictional.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

type Style = "flat" | "outline";

interface Brief {
  title: string;
  width: number;
  height: number;
  brief: string;
  alt_text: string;
  palette: string[];
  summary: string;
}

const BRIEFS: Record<string, Brief> = {
  "launch-poster": {
    title: "Sample Co. launch poster",
    width: 1200,
    height: 630,
    brief: "Landscape launch poster for Sample Co.: the headline 'Now shipping' set large at the left, a rising-sun motif of four concentric arcs in the bottom-right corner, navy ground, amber accent, cream type, with a small 'sample' caption bottom-left.",
    alt_text: "Navy poster with concentric amber arcs rising from the bottom-right corner and the headline Now shipping.",
    palette: ["#1B2A4A", "#F5A623", "#F6F1E7"],
    summary: "A prepared sample poster for Sample Co.: navy ground, amber arcs and the headline \"Now shipping\", at 1200 by 630.",
  },
  "product-icon": {
    title: "Sample Co. product icon",
    width: 512,
    height: 512,
    brief: "Square app icon for Sample Co.: a teal rounded tile carrying a white ring with an amber dot at its upper-right shoulder, the wordmark and a small 'sample' caption centred beneath.",
    alt_text: "Teal rounded-square icon with a white ring, an amber dot and the wordmark Sample Co.",
    palette: ["#0F766E", "#FFFFFF", "#F59E0B"],
    summary: "A prepared sample icon for Sample Co.: a teal tile with a white ring and an amber dot, at 512 by 512.",
  },
  "social-card": {
    title: "Sample Co. social card",
    width: 1080,
    height: 1080,
    brief: "Square social card for Sample Co.: a two-by-two grid of plum rounded squares and mint discs at the top-left, the headline 'Meet the new plan' on two lines below, cream ground, with a small 'sample' caption bottom-right.",
    alt_text: "Cream square card with a grid of plum squares and mint circles and the headline Meet the new plan.",
    palette: ["#FAF6EE", "#5B2A86", "#7FD1B9"],
    summary: "A prepared sample social card for Sample Co.: plum and mint shapes on a cream ground with the headline \"Meet the new plan\", at 1080 by 1080.",
  },
};

const STYLE_NOTES: Record<Style, string> = {
  flat: "Solid colour shapes on a single ground: no gradients, shadows or textures. The headline is set in the system sans at one bold weight; the wordmark and caption are smaller and lighter.",
  outline: "The same composition with every fill removed and each shape drawn as a thin stroke in its palette colour on the ground, so the motif reads as line work. Type is unchanged from the flat variant.",
};

/** Both variants link the same file. Said plainly so the agent does not report an outline render. */
const STYLE_NOTE = "The sample asset is rendered flat; the outline variant is described in style_notes only, and both variants link the same file.";

export const imageCreation: DemoServiceDefinition = {
  slug: "image-creation",
  name: "Image creation",
  description: "A prepared image for one of three fixed briefs, delivered as a link to a hand-drawn SVG with its dimensions, palette and alt text.",
  price: "0.020",
  params: [
    {
      name: "brief_id",
      required: true,
      description: "Which prepared brief to deliver. Each is a fixed composition for the fictional Sample Co.",
      enum: Object.keys(BRIEFS),
      example: "launch-poster",
    },
    {
      name: "style",
      required: false,
      description: "How the composition is treated. The sample file is rendered flat; outline is described in the notes only.",
      enum: ["flat", "outline"],
      default: "flat",
      example: "flat",
    },
  ],
  returns: {
    asset_url: "string, site-relative path to the SVG",
    width: "number",
    height: "number",
    format: "string, always svg",
    alt_text: "string",
    palette: "[hex string]",
    brief: "string",
    variant: "\"flat\" | \"outline\"",
    style_notes: "string",
    style_note: "string",
  },
  examplePrompts: [
    "Buy me the launch-poster image and tell me its dimensions and palette.",
    "Get the product-icon image in the outline style and describe what it looks like.",
  ],
  resultFor(params): DemoResult {
    const id = Object.hasOwn(BRIEFS, params.brief_id) ? params.brief_id : "launch-poster";
    const brief = BRIEFS[id];
    const style: Style = params.style === "outline" ? "outline" : "flat";
    const asset_url = `/demo/services/image-${id}.svg`;
    return {
      scenario_id: id,
      as_of: AS_OF,
      summary: brief.summary,
      data: {
        asset_url,
        width: brief.width,
        height: brief.height,
        format: "svg",
        alt_text: brief.alt_text,
        palette: brief.palette,
        brief: brief.brief,
        variant: style,
        style_notes: STYLE_NOTES[style],
        style_note: STYLE_NOTE,
      },
      sources: [{ title: brief.title, url: asset_url }],
    };
  },
};
