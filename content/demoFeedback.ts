/**
 * The demo feedback form: the one place the Tally form is configured. `formId` is the id
 * after tally.so/r/. `context` fills the form's hidden fields so each submission says
 * where it came from; keys are limited to the allowlist in lib/tally.ts and the values
 * are fixed here, never read from the request.
 */
export const demoFeedback = {
  formId: "0Q4aDP",
  context: {
    source: "demo-feedback",
    environment: "testnet",
    page: "/demo-feedback",
  },
};
