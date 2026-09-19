import { receiveDemoFeedback } from "@/lib/demoFeedbackIntake";

export const runtime = "nodejs";
export const maxDuration = 10;

/** The webhook only accepts POST; a GET answers a typed JSON 405 like every other API error. */
export function GET() {
  return Response.json(
    { error: { code: "method_not_allowed", message: "This endpoint receives signed form submissions by POST. The form is at /demo-feedback." } },
    { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  return receiveDemoFeedback(request);
}
