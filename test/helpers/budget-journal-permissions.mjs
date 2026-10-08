import { join } from 'node:path';
const { writeJournalFile } = await import(join(process.env.BUDGET_DURABILITY_ROOT, 'budget/journal.mjs'));
writeJournalFile(join(process.env.SUPERSTABLES_HOME, 'locked/home/budget/ops/test.json'), '{"state":"submitted"}');
