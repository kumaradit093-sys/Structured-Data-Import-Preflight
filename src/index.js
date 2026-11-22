import { extname } from 'node:path';
import { PreflightError } from './errors.js';
import { readCsv, readJson } from './input.js';
import { isPlainObject, normalizeSchema } from './schema.js';
import { createCollector } from './validator.js';

export { PreflightError } from './errors.js';
export { formatReport } from './report.js';

/**
 * @typedef {object} PreflightOptions
 * @property {'csv'|'json'} [format] Format override for preflightFile.
 * @property {string} [delimiter=','] CSV field delimiter.
 * @property {boolean} [strictColumns=false] Treat unexpected fields as errors.
 * @property {'warn'|'ignore'} [unexpectedColumns='warn'] Non-strict handling.
 * @property {number} [maxFileSize=10485760] Maximum input bytes.
 * @property {number} [maxIssues=100] Maximum number of issues stored in the report.
 */
function normalizeOptions(options, extension, memory = false) {
  if (!isPlainObject(options)) throw new PreflightError('INVALID_OPTIONS', 'Options must be an object.');
  const {
    format = extension, delimiter = ',', strictColumns = false, unexpectedColumns = 'warn',
    maxFileSize = 10 * 1024 * 1024, maxIssues = 100, ...unknown
  } = options;
  if (Object.keys(unknown).length) throw new PreflightError('INVALID_OPTIONS', 'Unknown preflight option.');
  if (!['csv', 'json'].includes(format)) {
    throw new PreflightError('UNSUPPORTED_FORMAT', 'Expected CSV or JSON input. Supply format explicitly for other extensions.');
  }
  if ((memory && format !== 'json') || typeof strictColumns !== 'boolean'
    || !['warn', 'ignore'].includes(unexpectedColumns) || !Number.isSafeInteger(maxFileSize)
    || maxFileSize < 1 || !Number.isSafeInteger(maxIssues) || maxIssues < 0
    || typeof delimiter !== 'string' || !delimiter.length || /["\r\n\0]/u.test(delimiter)
    || (format !== 'csv' && Object.hasOwn(options, 'delimiter'))) {
    throw new PreflightError('INVALID_OPTIONS', 'Invalid format-specific option, column policy, delimiter, or limit.');
  }
  return { format, delimiter, strictColumns, unexpectedColumns, maxFileSize, maxIssues };
}

/**
 * Read and validate a UTF-8 CSV or JSON file.
 * @param {string} file Input path.
 * @param {object} schema Field rules and optional composite unique groups.
 * @param {PreflightOptions} [options] Parsing and reporting options.
 * @returns {Promise<object>} Structured preflight report.
 */
export async function preflightFile(file, schema, options = {}) {
  if (typeof file !== 'string' || file.length === 0 || file.includes('\0')) {
    throw new PreflightError('INVALID_FILE_PATH', 'Expected a nonempty file path.');
  }
  const settings = normalizeOptions(options, extname(file).slice(1).toLowerCase());
  const collector = createCollector(normalizeSchema(schema, settings.format), settings, file);
  if (settings.format === 'csv') await readCsv(file, settings, collector);
  else await readJson(file, settings.maxFileSize, collector);
  return collector.report();
}

/**
 * Validate already parsed records with JSON type semantics.
 * @param {object[]} records Plain objects to inspect.
 * @param {object} schema Field rules and optional composite unique groups.
 * @param {PreflightOptions} [options] Column and reporting options.
 * @returns {object} Structured preflight report.
 */
export function preflightData(records, schema, options = {}) {
  const settings = normalizeOptions(options, 'json', true);
  const collector = createCollector(normalizeSchema(schema, 'json'), settings, null);
  collector.json(records);
  return collector.report();
}
