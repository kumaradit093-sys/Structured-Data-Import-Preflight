import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatReport, preflightFile } from 'data-import-preflight';

const schema = JSON.parse(await readFile(new URL('./schema.json', import.meta.url), 'utf8'));
const input = process.argv[2] ?? fileURLToPath(new URL('./customers.csv', import.meta.url));
const report = await preflightFile(input, schema);

console.log(formatReport(report));
if (!report.ok) {
  console.error('Import cancelled due to preflight errors.');
  process.exitCode = report.hasParsingErrors ? 2 : 1;
} else {
  console.log('Data passed preflight. The application can proceed to its import step.');
}
