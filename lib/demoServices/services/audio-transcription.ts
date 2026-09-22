// Audio transcription: a prepared transcript of one of three short sample clips. There is no
// audio file; each clip is described by its details and its timestamped segments. Speakers are
// labels rather than people, and nothing here runs a speech model.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";
const DEFAULT_CLIP = "standup-2026-09-14";

interface Segment {
  start_seconds: number;
  end_seconds: number;
  speaker: string;
  text: string;
}

interface Clip {
  title: string;
  duration_seconds: number;
  language: "en";
  speakers: string[];
  segments: Segment[];
  action_items: string[];
  summary: string;
}

const CLIPS: Record<string, Clip> = {
  "standup-2026-09-14": {
    title: "Engineering standup, 14 September 2026",
    duration_seconds: 90,
    language: "en",
    speakers: ["Speaker 1", "Speaker 2", "Speaker 3"],
    segments: [
      { start_seconds: 0, end_seconds: 7, speaker: "Speaker 1", text: "Morning, quick round. What shipped yesterday, what's blocked today. Go ahead." },
      { start_seconds: 7, end_seconds: 19, speaker: "Speaker 2", text: "Shipped the retry logic for failed settlements. Two flaky tests left, fixing them this morning." },
      { start_seconds: 19, end_seconds: 29, speaker: "Speaker 3", text: "Blocked on the staging keys. The rotation went out but the config was never redeployed." },
      { start_seconds: 29, end_seconds: 35, speaker: "Speaker 1", text: "I'll redeploy staging right after this call. Anything else from you?" },
      { start_seconds: 35, end_seconds: 47, speaker: "Speaker 3", text: "One layout bug on the receipt page on narrow screens. Should have it out by lunch." },
      { start_seconds: 47, end_seconds: 60, speaker: "Speaker 2", text: "One more thing. Rate limits on the sandbox facilitator are lower than the docs say." },
      { start_seconds: 60, end_seconds: 71, speaker: "Speaker 1", text: "Noted. I'll write to them today and we cap our retries at three meanwhile." },
      { start_seconds: 71, end_seconds: 83, speaker: "Speaker 2", text: "Works for me. Demo prep is on track for Thursday, nothing else to flag." },
      { start_seconds: 83, end_seconds: 90, speaker: "Speaker 1", text: "Good, that's everything. Standup done, thanks both, see you tomorrow." },
    ],
    action_items: [
      "Redeploy staging with the rotated keys (Speaker 1)",
      "Fix the two flaky retry tests (Speaker 2)",
      "Ship the receipt page layout fix by lunch (Speaker 3)",
      "Ask the sandbox facilitator about its rate limits (Speaker 1)",
    ],
    summary: "A prepared transcript of a 90-second, three-person engineering standup: retry logic shipped, staging keys blocked, four action items.",
  },
  "customer-call-excerpt": {
    title: "Support call excerpt: failed test payment",
    duration_seconds: 75,
    language: "en",
    speakers: ["Speaker 1", "Speaker 2"],
    segments: [
      { start_seconds: 0, end_seconds: 6, speaker: "Speaker 1", text: "Thanks for calling support. I can see your ticket about a failed test payment." },
      { start_seconds: 6, end_seconds: 17, speaker: "Speaker 2", text: "Right. My agent tried to pay a demo service and just got a 402 back again." },
      { start_seconds: 17, end_seconds: 28, speaker: "Speaker 1", text: "A second 402 usually means the signature was rejected. Which network was the wallet on?" },
      { start_seconds: 28, end_seconds: 37, speaker: "Speaker 2", text: "Base Sepolia, I think. It had test USDC in it, I topped it up yesterday." },
      { start_seconds: 37, end_seconds: 49, speaker: "Speaker 1", text: "The balance is fine. The payment was signed for the mainnet chain id, so it was refused." },
      { start_seconds: 49, end_seconds: 58, speaker: "Speaker 2", text: "Ah. So I switch the wallet's network before the agent retries?" },
      { start_seconds: 58, end_seconds: 68, speaker: "Speaker 1", text: "Exactly. Switch to Base Sepolia, retry once, and the receipt should come straight back." },
      { start_seconds: 68, end_seconds: 75, speaker: "Speaker 2", text: "Great, I'll try that now. Thanks for the quick answer." },
    ],
    action_items: [
      "Customer: switch the wallet to Base Sepolia and retry the payment once",
      "Support: add the expected chain id to the 402 error text",
    ],
    summary: "A prepared transcript of a 75-second support call: a test payment was refused twice because it was signed for the wrong chain id, and the fix is a network switch.",
  },
  "podcast-intro": {
    title: "Podcast introduction: agents that pay per request",
    duration_seconds: 60,
    language: "en",
    speakers: ["Speaker 1"],
    segments: [
      { start_seconds: 0, end_seconds: 9, speaker: "Speaker 1", text: "Welcome back to the show. This week we're talking about how software agents pay for things." },
      { start_seconds: 9, end_seconds: 21, speaker: "Speaker 1", text: "Not with a saved card, but with a small stablecoin payment attached to a single web request." },
      { start_seconds: 21, end_seconds: 33, speaker: "Speaker 1", text: "We'll cover what a 402 response actually means, and why the amounts are usually fractions of a cent." },
      { start_seconds: 33, end_seconds: 45, speaker: "Speaker 1", text: "Later, a guest walks through a live testnet demo, including one payment that fails on purpose." },
      { start_seconds: 45, end_seconds: 54, speaker: "Speaker 1", text: "If you're new here, everything we mention is linked in the episode notes." },
      { start_seconds: 54, end_seconds: 60, speaker: "Speaker 1", text: "Okay, let's get into it. First, the basics of a paid request." },
    ],
    action_items: [],
    summary: "A prepared transcript of a 60-second podcast introduction: one host previews an episode on how software agents pay for single requests in stablecoins.",
  },
};

/** The whole clip as one string, one speaker-labelled line per segment. */
function transcriptOf(clip: Clip): string {
  return clip.segments.map((s) => `${s.speaker}: ${s.text}`).join("\n");
}

export const audioTranscription: DemoServiceDefinition = {
  slug: "audio-transcription",
  name: "Audio transcription",
  description: "A prepared transcript of one of three short sample audio clips: clip details, timestamped speaker-labelled segments and any action items.",
  price: "0.010",
  params: [
    {
      name: "clip_id",
      required: true,
      description: "Which prepared sample clip the transcript is for. These are fictional clips; there is no audio file behind them.",
      enum: Object.keys(CLIPS),
      example: DEFAULT_CLIP,
    },
    {
      name: "format",
      required: false,
      description: "Timestamped segments, or the whole transcript as one speaker-labelled string.",
      enum: ["segments", "text"],
      default: "segments",
      example: "segments",
    },
  ],
  returns: {
    clip: "{ id, title, duration_seconds, language, speakers[] }",
    format: "string",
    segments: "[{ start_seconds, end_seconds, speaker, text }], when format is segments",
    transcript: "string, one speaker-labelled line per segment, when format is text",
    action_items: "string[]",
  },
  examplePrompts: [
    "Buy a transcript of the sample clip standup-2026-09-14 and list the action items.",
    "Get the customer-call-excerpt transcript as plain text and tell me why the payment failed.",
  ],
  resultFor(params): DemoResult {
    const id = Object.hasOwn(CLIPS, params.clip_id) ? params.clip_id : DEFAULT_CLIP;
    const clip = CLIPS[id];
    const format = params.format === "text" ? "text" : "segments";
    return {
      scenario_id: id,
      as_of: AS_OF,
      summary: clip.summary,
      data: {
        clip: { id, title: clip.title, duration_seconds: clip.duration_seconds, language: clip.language, speakers: clip.speakers },
        format,
        ...(format === "text" ? { transcript: transcriptOf(clip) } : { segments: clip.segments }),
        action_items: clip.action_items,
      },
      sources: [],
    };
  },
};
