import { isPlainObject, matchesType } from './schema.js';

const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const integer = /^[+-]?\d+$/u;

function comparable(raw, type, format) {
  if (format !== 'csv' || type === 'string') return raw;
  const value = raw.trim();
  if (type === 'boolean') {
    if (value === 'true' || value === 'false') return value === 'true';
    return undefined;
  }
  if (type === 'date') return value;
  const syntax = type === 'integer' ? integer : decimal;
  return syntax.test(value) ? Number(value) : undefined;
}

function emptyReason(value, present) {
  if (!present) return 'missing';
  if (value === undefined) return 'undefined';
  if (value === '') return 'empty';
  if (typeof value === 'string' && !value.trim()) return 'whitespace';
  return undefined;
}

function checkCustom(validate, value, record, context, issue) {
  if (!validate) return;
  try {
    const result = validate(value, record, { ...context });
    if (result === true) return;
    if (typeof result === 'string' && result.trim()) {
      issue('CUSTOM_VALIDATION_FAILED', result);
    } else {
      // Consume a rejected promise from an accidentally asynchronous validator.
      if (typeof result?.then === 'function') Promise.resolve(result).catch(() => {});
      issue('INVALID_CUSTOM_RESULT', 'Custom validator must return true or a nonempty message.');
    }
  } catch {
    issue('CUSTOM_VALIDATOR_ERROR', 'Custom validator threw an exception.');
  }
}

function validateField(record, rule, field, format, location, add) {
  const context = { ...location, field, format };
  const issue = (code, message, details) => add(code, message, { ...location, field, ...details });
  const present = Object.hasOwn(record, field);
  const raw = present ? record[field] : undefined;
  const reason = emptyReason(raw, present);
  if (reason && !(reason === 'empty' && rule.allowEmpty) && !(reason === 'whitespace' && rule.allowWhitespace)) {
    if (rule.required) issue('MISSING_REQUIRED_FIELD', 'Required value is missing.', { reason });
    return undefined;
  }
  if (raw === null) {
    if (!rule.nullable) issue('NULL_NOT_ALLOWED', 'Null is not allowed.');
    return undefined;
  }
  const value = comparable(raw, rule.type, format);
  if (!matchesType(value, rule.type)) {
    issue('INVALID_TYPE', 'Value has the wrong type.', { expected: rule.type });
    return undefined;
  }

  for (const [key, measure, lowerBound] of [
    ['min', value, true],
    ['max', value, false],
    ['minLength', value.length, true],
    ['maxLength', value.length, false],
  ]) {
    if (Object.hasOwn(rule, key) && (lowerBound ? measure < rule[key] : measure > rule[key])) {
      issue('CONSTRAINT_VIOLATION', `Value violates ${key}.`, { expected: { [key]: rule[key] } });
    }
  }
  if (rule.pattern) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(value)) {
      issue('CONSTRAINT_VIOLATION', 'Value does not match the pattern.', {
        expected: { pattern: rule.pattern.toString() },
      });
    }
  }
  if (rule.enum && !rule.enum.includes(value)) {
    issue('CONSTRAINT_VIOLATION', 'Value is outside the allowed set.', { expected: { enum: [...rule.enum] } });
  }
  checkCustom(rule.validate, value, record, context, issue);
  return reason ? undefined : value;
}

export function createCollector(schema, options, file) {
  const { format, strictColumns, unexpectedColumns, maxIssues } = options;
  const issues = [];
  const summary = { totalRecords: 0, validRecords: 0, invalidRecords: 0, errors: 0, warnings: 0 };
  const trackers = schema.unique.map((fields) => ({ fields, seen: new Map() }));
  let hasParsingErrors = false;

  function add(code, message, { severity = 'error', category = 'validation', ...details } = {}) {
    summary[severity === 'error' ? 'errors' : 'warnings']++;
    if (severity === 'error' && category === 'parsing') hasParsingErrors = true;
    if (issues.length < maxIssues) issues.push({ code, severity, category, message, ...details });
  }

  function unexpected(field, location) {
    if (!schema.fields.has(field) && (strictColumns || unexpectedColumns === 'warn')) {
      add('UNEXPECTED_FIELD', 'Field is absent from the schema.', {
        field, ...location, severity: strictColumns ? 'error' : 'warning',
      });
    }
  }

  function headers(names, line) {
    const seen = new Set();
    for (const [index, field] of names.entries()) {
      const location = { line, column: index + 1 };
      if (!field.trim()) {
        add('EMPTY_CSV_HEADER', 'CSV column name is empty.', { ...location, category: 'parsing' });
      } else if (seen.has(field)) {
        add('DUPLICATE_CSV_HEADER', 'CSV column name is repeated.', { ...location, field, category: 'parsing' });
      } else {
        unexpected(field, location);
      }
      seen.add(field);
    }
    for (const [field, rule] of schema.fields) {
      if (!seen.has(field)) add('MISSING_COLUMN', 'Expected CSV column is absent.', {
        line, field, severity: rule.required ? 'error' : 'warning',
      });
    }
  }

  function validateRecord(record, location) {
    const values = new Map();
    for (const [field, rule] of schema.fields) {
      values.set(field, validateField(record, rule, field, format, location, add));
    }
    for (const { fields, seen } of trackers) {
      const tuple = fields.map((field) => values.get(field));
      if (tuple.includes(undefined)) continue;
      const key = JSON.stringify(tuple);
      const firstOccurrence = seen.get(key);
      if (firstOccurrence) {
        const reference = fields.length === 1 ? { field: fields[0] } : { fields: [...fields] };
        add('DUPLICATE_VALUE', 'Value already appeared in an earlier record.', {
          ...location, ...reference, firstOccurrence: { ...firstOccurrence },
        });
      } else {
        seen.set(key, location);
      }
    }
  }

  function countRecord(check) {
    const errorsBefore = summary.errors;
    check();
    summary.totalRecords++;
    summary[summary.errors === errorsBefore ? 'validRecords' : 'invalidRecords']++;
  }

  function csv(names, cells, recordIndex, line) {
    const location = { recordIndex, line };
    countRecord(() => {
      if (cells.length !== names.length) {
        add('CSV_COLUMN_COUNT', 'CSV record has the wrong number of columns.', {
          ...location, category: 'parsing', expected: names.length, actual: cells.length,
        });
      }
      if (cells.every((cell) => !cell.trim())) {
        add('EMPTY_RECORD', 'CSV record has no nonblank values.', location);
      }
      const record = Object.create(null);
      for (let index = 0; index < Math.min(names.length, cells.length); index++) {
        const field = names[index];
        if (field.trim() && !Object.hasOwn(record, field)) record[field] = cells[index];
      }
      validateRecord(record, location);
    });
  }

  function json(records) {
    if (!Array.isArray(records)) {
      add('INVALID_JSON_ROOT', 'Expected a top-level array of objects.', { category: 'parsing' });
      return;
    }
    for (const [index, record] of records.entries()) {
      const location = { recordIndex: index + 1 };
      countRecord(() => {
        if (!isPlainObject(record)) {
          add('INVALID_RECORD', 'Expected a plain object.', location);
          return;
        }
        const keys = Object.keys(record);
        if (keys.length === 0) add('EMPTY_RECORD', 'Record has no fields.', location);
        for (const field of keys) unexpected(field, location);
        validateRecord(record, location);
      });
    }
  }

  function report() {
    return {
      ok: summary.errors === 0,
      file,
      format,
      summary,
      hasParsingErrors,
      omittedIssues: summary.errors + summary.warnings - issues.length,
      issues,
    };
  }

  return { add, headers, csv, json, report };
}
