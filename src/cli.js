#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { formatReport, preflightFile, PreflightError } from './index.js';
import { readUtf8 } from './input.js';

const help = `Usage: data-import-preflight --file PATH --schema PATH [options]

  --file PATH        CSV or JSON input
  --schema PATH      JSON schema configuration
  --format FORMAT    csv or json (default: infer from extension)
  --output STYLE     pretty or json (default: pretty)
  --max-issues N     Maximum displayed issues (default: 100)
  --help             Show usage
  --version          Show package version`;

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      schema: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string', default: 'pretty' },
      'max-issues': { type: 'string' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version) {
    const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    console.log(JSON.parse(manifest).version);
    return;
  }
  if (!values.file || !values.schema) throw new Error('Both --file and --schema are required.');
  if (!['pretty', 'json'].includes(values.output)) throw new Error('--output must be pretty or json.');
  const max = values['max-issues'];
  if (max !== undefined && !/^\d+$/u.test(max)) throw new Error('--max-issues must be a nonnegative integer.');
  let schema;
  try {
    schema = JSON.parse(await readUtf8(values.schema, 1024 * 1024));
  } catch (error) {
    const detail = error instanceof PreflightError ? error.message : 'Expected valid JSON.';
    throw new Error(`Cannot load schema. ${detail}`);
  }
  const report = await preflightFile(values.file, schema, {
    format: values.format,
    maxIssues: max === undefined ? undefined : Number(max),
  });
  console.log(values.output === 'json' ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = report.hasParsingErrors ? 2 : Number(!report.ok);
}

try {
  await main();
} catch (error) {
  // Parser and system exceptions may contain values or unexplained paths.
  const message = String(error.message).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  console.error(`data-import-preflight: ${message}`);
  process.exitCode = 2;
}
