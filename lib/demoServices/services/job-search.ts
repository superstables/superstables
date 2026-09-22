// Job search: prepared listings for one of three roles in one region. Four openings per
// role, placed at fictional companies with region-specific locations and salary bands;
// nothing here queries a job board, and every date is fixed in September 2026.

import type { DemoResult, DemoServiceDefinition } from "../types";

const AS_OF = "2026-09-21T09:00:00Z";

const REGIONS = ["eu", "us", "remote"] as const;
type Region = (typeof REGIONS)[number];

/** Exactly four of something, so a role's openings and a region's slots always line up. */
type Four<T> = [T, T, T, T];

/** One opening of a role: the same title and requirements everywhere, a salary band per region. */
interface Opening {
  title: string;
  requirements: string;
  salary: Record<Region, string>;
}

interface Role {
  label: string;
  openings: Four<Opening>;
  market_note: Record<Region, string>;
}

/** Where the i-th opening of any role sits in a region: the company, its location and the post date. */
interface Slot {
  company: string;
  location: string;
  remote: boolean;
  posted_on: string;
}

const SLOTS: Record<Region, Four<Slot>> = {
  eu: [
    { company: "Demo Payments GmbH", location: "Berlin, Germany", remote: false, posted_on: "2026-09-15" },
    { company: "Example Protocol", location: "Lisbon, Portugal", remote: false, posted_on: "2026-09-10" },
    { company: "Sample Labs", location: "Amsterdam, Netherlands", remote: true, posted_on: "2026-09-08" },
    { company: "Fixture Finance SAS", location: "Paris, France", remote: true, posted_on: "2026-09-18" },
  ],
  us: [
    { company: "Sample Labs", location: "New York, NY", remote: false, posted_on: "2026-09-16" },
    { company: "Placeholder Finance Inc.", location: "San Francisco, CA", remote: true, posted_on: "2026-09-12" },
    { company: "Example Protocol", location: "Austin, TX", remote: false, posted_on: "2026-09-08" },
    { company: "Sandbox Chain Co.", location: "Denver, CO", remote: true, posted_on: "2026-09-19" },
  ],
  remote: [
    { company: "Example Protocol", location: "Remote (UTC-5 to UTC+2)", remote: true, posted_on: "2026-09-17" },
    { company: "Sample Labs", location: "Remote (Americas)", remote: true, posted_on: "2026-09-11" },
    { company: "Demo Payments GmbH", location: "Remote (EU hours)", remote: true, posted_on: "2026-09-14" },
    { company: "Testnet Studio", location: "Remote (any time zone)", remote: true, posted_on: "2026-09-19" },
  ],
};

const REGION_PHRASE: Record<Region, string> = {
  eu: "across EU cities",
  us: "across US cities",
  remote: "at remote-first teams",
};

const ROLES: Record<string, Role> = {
  "solidity-engineer": {
    label: "Solidity engineer",
    openings: [
      {
        title: "Senior Solidity Engineer",
        requirements: "4+ years of Solidity, Foundry test suites, one audited mainnet deployment",
        salary: { eu: "EUR 110,000 to 140,000", us: "USD 180,000 to 230,000", remote: "USD 160,000 to 200,000" },
      },
      {
        title: "Smart Contract Engineer, Payments",
        requirements: "ERC-20 and EIP-3009 flows, gas profiling, comfortable pairing with auditors",
        salary: { eu: "EUR 90,000 to 115,000", us: "USD 150,000 to 190,000", remote: "EUR 95,000 to 120,000" },
      },
      {
        title: "Protocol Engineer (Solidity and Rust)",
        requirements: "Solidity plus working Rust, upgradeable proxy patterns, on-call rotation",
        salary: { eu: "EUR 100,000 to 130,000", us: "USD 170,000 to 210,000", remote: "GBP 90,000 to 115,000" },
      },
      {
        title: "Solidity Engineer, Wallet Infrastructure",
        requirements: "Account abstraction (ERC-4337), signature schemes, TypeScript tooling",
        salary: { eu: "EUR 85,000 to 110,000", us: "USD 140,000 to 175,000", remote: "USD 130,000 to 165,000" },
      },
    ],
    market_note: {
      eu: "In this sample, EU Solidity openings cluster in Berlin, Lisbon and Paris, and the payments teams pay at the top of the band.",
      us: "In this sample, US Solidity openings pay 40 to 60 percent above their EU counterparts and half allow remote work.",
      remote: "In this sample, remote-first Solidity openings quote USD, EUR or GBP and expect overlap with EU or US-East hours.",
    },
  },
  "developer-advocate": {
    label: "Developer advocate",
    openings: [
      {
        title: "Developer Advocate, Stablecoin Payments",
        requirements: "Ships sample apps and docs, speaks at meetups, has shipped production code",
        salary: { eu: "EUR 75,000 to 95,000", us: "USD 130,000 to 160,000", remote: "USD 110,000 to 140,000" },
      },
      {
        title: "Senior Developer Relations Engineer",
        requirements: "5+ years in engineering or DevRel, owns an SDK, clear technical writing",
        salary: { eu: "EUR 85,000 to 105,000", us: "USD 150,000 to 185,000", remote: "EUR 80,000 to 100,000" },
      },
      {
        title: "Technical Community Lead",
        requirements: "Runs a developer forum and office hours, triages SDK issues, writes tutorials",
        salary: { eu: "EUR 65,000 to 85,000", us: "USD 115,000 to 145,000", remote: "GBP 65,000 to 85,000" },
      },
      {
        title: "Developer Advocate, Agent Tooling",
        requirements: "Builds agent demos against paid endpoints, records walkthroughs, Python and TypeScript",
        salary: { eu: "EUR 70,000 to 90,000", us: "USD 125,000 to 155,000", remote: "USD 105,000 to 135,000" },
      },
    ],
    market_note: {
      eu: "In this sample, EU developer advocate openings favour candidates who can present in English and one other EU language.",
      us: "In this sample, US developer advocate openings expect conference travel and pay closer to engineering bands.",
      remote: "In this sample, remote-first developer advocate openings weigh a public portfolio of talks and tutorials above location.",
    },
  },
  "product-designer": {
    label: "Product designer",
    openings: [
      {
        title: "Senior Product Designer, Wallet",
        requirements: "Portfolio of shipped mobile flows, Figma component systems, runs usability tests",
        salary: { eu: "EUR 80,000 to 100,000", us: "USD 145,000 to 180,000", remote: "USD 125,000 to 155,000" },
      },
      {
        title: "Product Designer, Payments Onboarding",
        requirements: "KYC and checkout flows, design tokens, works directly with engineers",
        salary: { eu: "EUR 65,000 to 85,000", us: "USD 120,000 to 150,000", remote: "EUR 70,000 to 90,000" },
      },
      {
        title: "Staff Product Designer",
        requirements: "8+ years, has led a design system, mentors a small team",
        salary: { eu: "EUR 95,000 to 120,000", us: "USD 175,000 to 215,000", remote: "GBP 95,000 to 120,000" },
      },
      {
        title: "Product Designer, Developer Tools",
        requirements: "Designs docs, dashboards and CLIs, reads code well enough to prototype",
        salary: { eu: "EUR 70,000 to 90,000", us: "USD 130,000 to 160,000", remote: "USD 115,000 to 145,000" },
      },
    ],
    market_note: {
      eu: "In this sample, EU product designer openings are mostly on-site or hybrid, with Berlin and Paris paying the most.",
      us: "In this sample, US product designer openings at payments companies pay a premium for prior fintech work.",
      remote: "In this sample, remote-first product designer openings ask for async written design reviews rather than fixed hours.",
    },
  },
};

export const jobSearch: DemoServiceDefinition = {
  slug: "job-search",
  name: "Job search",
  description: "Prepared sample job listings for one role in one region: title, company, location, salary range, requirements and how to apply.",
  price: "0.003",
  params: [
    {
      name: "role_id",
      required: true,
      description: "Which prepared role to list openings for.",
      enum: Object.keys(ROLES),
      example: "solidity-engineer",
    },
    {
      name: "region",
      required: false,
      description: "Where the listings are based: EU cities with EUR bands, US cities with USD bands, or remote-first teams in mixed currencies.",
      enum: REGIONS,
      default: "remote",
      example: "remote",
    },
  ],
  returns: {
    role: "string",
    region: "string",
    listings: "[{ title, company, location, remote, salary_range, posted_on, requirements, apply_note }]",
    market_note: "string",
  },
  examplePrompts: [
    "Buy me the sample job listings for solidity-engineer in the eu region.",
    "Find developer-advocate openings and tell me which ones are remote.",
  ],
  resultFor(params): DemoResult {
    const roleId = Object.hasOwn(ROLES, params.role_id) ? params.role_id : "solidity-engineer";
    const role = ROLES[roleId];
    const region: Region = REGIONS.find((r) => r === params.region) ?? "remote";
    const listings = role.openings.map((opening, i) => {
      const slot = SLOTS[region][i];
      return {
        title: opening.title,
        company: slot.company,
        location: slot.location,
        remote: slot.remote,
        salary_range: opening.salary[region],
        posted_on: slot.posted_on,
        requirements: opening.requirements,
        apply_note: `Applications go through the ${slot.company} careers site.`,
      };
    });
    return {
      scenario_id: `${roleId}-${region}`,
      as_of: AS_OF,
      summary: `Prepared sample listings: ${listings.length} ${role.label.toLowerCase()} openings ${REGION_PHRASE[region]}, from fictional companies, posted in September 2026.`,
      data: { role: role.label, region, listings, market_note: role.market_note[region] },
      sources: [],
    };
  },
};
