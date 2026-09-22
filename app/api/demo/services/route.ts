// /api/demo/services is the API catalog's anchor for the prepared demo services; it answers
// with the same hosted catalogue as /api/demo/catalogue, so the advertised link never 404s.

export { GET, OPTIONS, dynamic } from "../catalogue/route";
