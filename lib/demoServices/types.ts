// The shape of a prepared demo service: a paid endpoint that sells a fixed set of prepared
// answers so an agent can ask, the owner can approve one testnet payment, and a useful result
// comes back with a payment record. The payment mechanics are shared (lib/demoSeller.ts);
// each service module supplies only what it sells.
//
// Every input is a closed set. A service never guesses: a value outside its set is a 400
// before any payment is demanded, and discovery publishes the sets so an agent can build a
// valid request without reading documentation.

/** One query parameter of a demo service. Values are matched case-insensitively. */
export interface DemoParam {
  name: string;
  required: boolean;
  description: string;
  /** The closed set of accepted values, in their canonical spelling. */
  enum: readonly string[];
  /** Used when an optional parameter is omitted. Must be one of `enum`. */
  default?: string;
  /** A valid value, for discovery probes and documentation. Must be one of `enum`. */
  example: string;
}

/** A sample document the result cites. `url` may be site-relative; the route absolutises it. */
export interface DemoSource {
  title: string;
  url: string;
  section?: string;
}

/** What a service module returns for one valid combination of parameters. */
export interface DemoResult {
  /** Which prepared scenario answered, e.g. "demo-active". Technical evidence, not user copy. */
  scenario_id: string;
  /** A fixed ISO 8601 timestamp describing the prepared data, never the time of the request. */
  as_of: string;
  /** One or two sentences the agent can quote directly. */
  summary: string;
  data: Record<string, unknown>;
  sources: DemoSource[];
}

export interface DemoServiceDefinition {
  /** The route suffix under /api/demo/services/, lowercase with hyphens. */
  slug: string;
  name: string;
  /** What the service sells, in one sentence. The registry appends the disclosure. */
  description: string;
  /** Test USDC per call, decimal. Stored as a decimal string so 0.003 is exactly that. */
  price: string;
  params: DemoParam[];
  /** What the agent gets back, field by field, for the self-description. */
  returns: Record<string, string>;
  /** Prompts a user can type as they are. Each must be answerable with this service alone. */
  examplePrompts: string[];
  /** The prepared answer for one valid, defaulted set of parameters. Must never throw. */
  resultFor(params: Record<string, string>): DemoResult;
}

/** What every paid 200 from a demo service looks like. `data` is service-specific. */
export interface DemoEnvelope {
  service_id: string;
  provider: string;
  mock: true;
  notice: string;
  scenario_id: string;
  fixture_version: string;
  as_of: string;
  summary: string;
  data: Record<string, unknown>;
  sources: DemoSource[];
  paid: { amount: string; asset: string; network: string; transaction: string };
}
