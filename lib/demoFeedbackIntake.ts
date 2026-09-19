import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const FORM_ID = "0Q4aDP";
const TEAM_ID = "1505e9ed-741b-4233-a192-702983473be9";
const LABEL_NAME = "Tally Demo Feedback";
const MAX_BODY_BYTES = 64 * 1024;
const BUDGET_MS = 8000;

const configSchema = z.object({
  apiKey: z.string().trim().min(1),
  signingSecret: z.string().refine((value) => value.trim().length > 0),
  labelId: z.uuid(),
  triageId: z.uuid(),
});
type IntakeConfig = z.infer<typeof configSchema>;

const eventSchema = z.object({
  eventType: z.literal("FORM_RESPONSE"),
  data: z.object({
    formId: z.literal(FORM_ID),
    submissionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    fields: z.array(z.object({
      label: z.string().nullish(),
      type: z.string(),
      value: z.unknown(),
    })).max(64),
  }),
});

const fileSchema = z.object({
  name: z.string().min(1).max(1024),
  url: z.url().max(8192).refine((value) => {
    const url = new URL(value);
    return url.origin === "https://storage.tally.so" && !url.username && !url.password;
  }).transform((value) => new URL(value).href),
});
const filesSchema = z.array(fileSchema).max(10);
const reportSchema = z.string().min(1).max(50000).refine((value) => value.trim().length > 0);
const contactSchema = z.string().max(1000);

const issueSchema = z.object({ id: z.uuid(), team: z.object({ id: z.literal(TEAM_ID) }) });
const lookupSchema = z.object({ issues: z.object({ nodes: z.array(issueSchema).max(1) }) });
const preflightSchema = lookupSchema.extend({
  issueLabel: z.object({
    id: z.uuid(), name: z.literal(LABEL_NAME), archivedAt: z.null(),
    team: z.object({ id: z.literal(TEAM_ID) }).nullable(),
  }),
  workflowState: z.object({
    id: z.uuid(), type: z.literal("triage"), archivedAt: z.null(),
    team: z.object({ id: z.literal(TEAM_ID) }),
  }),
});
const createSchema = z.object({
  issueCreate: z.object({ success: z.literal(true), issue: issueSchema }),
});
const envelopeSchema = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() });

const LOOKUP = "query DemoFeedbackLookup($id: ID!) { issues(filter: {id: {eq: $id}}, first: 1, includeArchived: true) { nodes { id team { id } } } }";
const PREFLIGHT = "query DemoFeedbackPreflight($id: ID!, $labelId: String!, $triageId: String!) { issues(filter: {id: {eq: $id}}, first: 1, includeArchived: true) { nodes { id team { id } } } issueLabel(id: $labelId) { id name archivedAt team { id } } workflowState(id: $triageId) { id type archivedAt team { id } } }";
const CREATE = "mutation DemoFeedbackCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id team { id } } } }";

class IntakeFailure extends Error {
  constructor(readonly status: number) {
    super("Demo feedback intake failed");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, status: number): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new IntakeFailure(status);
  return result.data;
}

async function readBody(request: Request, signal: AbortSignal): Promise<string> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new IntakeFailure(413);
  }
  if (!request.body) throw new IntakeFailure(400);
  signal.throwIfAborted();
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancel();
        throw new IntakeFailure(413);
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function issueIdFor(submissionId: string): string {
  // Linear's IssueCreateInput.id requires UUID v4 format; keep this mapping stable.
  const bytes = createHash("sha256")
    .update("superstables:demo-feedback:" + FORM_ID + ":" + submissionId)
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function quote(value: string): string {
  return value.split(/\r\n?|\n/).map((line) => "> " + line.replace(/[\\\u0060*_[\]<>!]/g, "\\$&")).join("\n");
}

function feedbackInput(event: z.infer<typeof eventSchema>) {
  const fields = event.data.fields;
  const reports = fields.filter((field) => field.type === "TEXTAREA");
  const contacts = fields.filter((field) =>
    field.type === "INPUT_TEXT" || field.type === "INPUT_EMAIL");
  // This fixed form has one upload question, which may contain multiple files.
  const uploads = fields.filter((field) => field.type === "FILE_UPLOAD");
  if (reports.length !== 1 || contacts.length > 1 || uploads.length > 1) throw new IntakeFailure(400);
  const report = parse(reportSchema, reports[0].value, 400);
  const contact = parse(contactSchema, contacts[0]?.value ?? "", 400);
  const files = parse(filesSchema, uploads[0]?.value ?? [], 400);
  const firstLine = report.trim().split(/\r\n?|\n/, 1)[0].replace(/\s+/g, " ");
  const title = ("[Demo feedback] " + firstLine).slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
  const description = [
    "## Report\n\n" + quote(report),
    ...(contact.trim() ? ["## Contact\n\n" + quote(contact)] : []),
    ...(files.length ? ["## Attachments\n\n" + files.map((file) =>
      "- [" + file.name.replace(/[\r\n]/g, " ").replace(/[\\\u0060*_[\]<>!]/g, "\\$&") + "](<" + file.url + ">)").join("\n")] : []),
    "## Demo context\n\nsource: demo-feedback\nenvironment: testnet\npage: /demo-feedback",
    "Tally submission: " + FORM_ID + "/" + event.data.submissionId,
  ].join("\n\n");
  return { id: issueIdFor(event.data.submissionId), title, description };
}

async function linearRequest(
  query: string,
  variables: Record<string, unknown>,
  config: IntakeConfig,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: config.apiKey },
    body: JSON.stringify({ query, variables }),
    signal,
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new IntakeFailure(503);
  const payload: unknown = await response.json();
  const envelope = parse(envelopeSchema, payload, 503);
  if (envelope.errors?.length) throw new IntakeFailure(503);
  return envelope.data;
}

export async function receiveDemoFeedback(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUDGET_MS);
  const signal = AbortSignal.any([controller.signal, request.signal]);
  const headers = { "Cache-Control": "no-store" };
  try {
    if (request.method !== "POST") return Response.json({ ok: false }, { status: 405, headers: { ...headers, Allow: "POST" } });
    const config = parse(configSchema, {
      apiKey: process.env.DEMO_FEEDBACK_LINEAR_API_KEY,
      signingSecret: process.env.DEMO_FEEDBACK_TALLY_SIGNING_SECRET,
      labelId: process.env.DEMO_FEEDBACK_LINEAR_LABEL_ID,
      triageId: process.env.DEMO_FEEDBACK_LINEAR_TRIAGE_ID,
    }, 503);
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new IntakeFailure(415);
    }
    const signature = request.headers.get("tally-signature");
    if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) throw new IntakeFailure(401);
    const body = await readBody(request, signal);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new IntakeFailure(400);
    }
    // Tally documents HMAC over JSON.stringify(parsedPayload), not arbitrary wire whitespace.
    const expected = createHmac("sha256", config.signingSecret).update(JSON.stringify(payload)).digest();
    const received = Buffer.from(signature, "base64");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new IntakeFailure(401);
    const event = parse(eventSchema, payload, 400);
    const input = feedbackInput(event);
    const preflight = parse(preflightSchema, await linearRequest(PREFLIGHT, {
      id: input.id, labelId: config.labelId, triageId: config.triageId,
    }, config, signal), 503);
    if (preflight.issueLabel.id !== config.labelId || preflight.workflowState.id !== config.triageId) {
      throw new IntakeFailure(503);
    }
    const existing = preflight.issues.nodes[0];
    if (existing) {
      if (existing.id !== input.id) throw new IntakeFailure(503);
      return Response.json({ ok: true, id: input.id }, { headers });
    }
    try {
      const created = parse(createSchema, await linearRequest(CREATE, {
        input: { ...input, teamId: TEAM_ID, stateId: config.triageId, labelIds: [config.labelId], useDefaultTemplate: false },
      }, config, signal), 503);
      if (created.issueCreate.issue.id !== input.id) throw new IntakeFailure(503);
    } catch {
      // A concurrent delivery or a lost create response may already have persisted this ID.
      const lookup = parse(lookupSchema, await linearRequest(LOOKUP, { id: input.id }, config, signal), 503);
      if (lookup.issues.nodes[0]?.id !== input.id) throw new IntakeFailure(503);
    }
    return Response.json({ ok: true, id: input.id }, { headers });
  } catch (error) {
    return Response.json({ ok: false }, { status: error instanceof IntakeFailure ? error.status : 503, headers });
  } finally {
    clearTimeout(timeout);
  }
}
