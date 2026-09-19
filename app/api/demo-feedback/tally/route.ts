import { receiveDemoFeedback } from "@/lib/demoFeedbackIntake";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(request: Request) {
  return receiveDemoFeedback(request);
}
