import { PreflightError } from './errors.js';

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// UTC round-tripping rejects normalized dates such as February 30.
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const typeChecks = {
  string: (value) => typeof value === 'string',
  number: Number.isFinite,
  integer: Number.isSafeInteger,
  boolean: (value) => typeof value === 'boolean',
  date: isDate,
  array: Array.isArray,
};

export function matchesType(value, type) {
  return typeChecks[type](value);
}

const numericTypes = new Set(['number', 'integer']);
const fieldKeys = new Set([
  'type', 'required', 'nullable', 'unique', 'allowEmpty', 'allowWhitespace',
  'min', 'max', 'minLength', 'maxLength', 'pattern', 'enum', 'validate',
]);

function schemaError(message) {
  throw new PreflightError('INVALID_SCHEMA', message);
}

function normalizeField(name, rule) {
  const field = JSON.stringify(name);
  if (!name.trim() || !isPlainObject(rule) || typeof rule.type !== 'string'
    || !Object.hasOwn(typeChecks, rule.type)) {
    schemaError(`Field ${field} must have a supported type.`);
  }
  for (const key of Object.keys(rule)) {
    if (!fieldKeys.has(key)) schemaError(`Unknown rule ${JSON.stringify(key)} for field ${field}.`);
  }
  for (const key of ['required', 'nullable', 'unique', 'allowEmpty', 'allowWhitespace']) {
    if (Object.hasOwn(rule, key) && typeof rule[key] !== 'boolean') {
      schemaError(`${key} for field ${field} must be boolean.`);
    }
  }
  if (rule.type !== 'string' && ('allowEmpty' in rule || 'allowWhitespace' in rule)) {
    schemaError(`Empty-string options require a string field (${field}).`);
  }
  for (const key of ['min', 'max']) {
    if (!Object.hasOwn(rule, key)) continue;
    const valid = rule.type === 'date' ? isDate(rule[key])
      : numericTypes.has(rule.type) && Number.isFinite(rule[key]);
    if (!valid) schemaError(`Invalid ${key} for field ${field}.`);
  }
  for (const key of ['minLength', 'maxLength']) {
    if (!Object.hasOwn(rule, key)) continue;
    if (!['string', 'array'].includes(rule.type) || !Number.isSafeInteger(rule[key]) || rule[key] < 0) {
      schemaError(`Invalid ${key} for field ${field}.`);
    }
  }
  if (rule.min > rule.max || rule.minLength > rule.maxLength) {
    schemaError(`Minimum exceeds maximum for field ${field}.`);
  }
  let pattern;
  if (Object.hasOwn(rule, 'pattern')) {
    if (rule.type !== 'string' || !(typeof rule.pattern === 'string' || rule.pattern instanceof RegExp)) {
      schemaError(`Pattern for field ${field} must be a string or RegExp on a string field.`);
    }
    try {
      pattern = new RegExp(rule.pattern);
    } catch {
      schemaError(`Invalid pattern for field ${field}.`);
    }
  }
  if (Object.hasOwn(rule, 'enum') && (
    !['string', 'number', 'integer'].includes(rule.type) || !Array.isArray(rule.enum)
    || !rule.enum.length || !Array.from(rule.enum).every((value) => matchesType(value, rule.type))
  )) schemaError(`Invalid enum for field ${field}.`);
  if (Object.hasOwn(rule, 'validate') && typeof rule.validate !== 'function') {
    schemaError(`Custom validator for field ${field} must be a function.`);
  }
  return { ...rule, pattern };
}

export function normalizeSchema(schema, format) {
  if (!isPlainObject(schema) || !isPlainObject(schema.fields)
    || Object.keys(schema).some((key) => key !== 'fields' && key !== 'unique')) {
    schemaError('Expected a schema with a fields object and optional unique groups.');
  }
  const fields = new Map(Object.entries(schema.fields).map(([name, rule]) => [
    name, normalizeField(name, rule),
  ]));
  if (!fields.size) schemaError('Schema must define at least one field.');
  if (format === 'csv' && [...fields.values()].some((rule) => rule.type === 'array')) {
    schemaError('Array fields require JSON input.');
  }
  const groups = Object.hasOwn(schema, 'unique') ? schema.unique : [];
  if (!Array.isArray(groups)) schemaError('Schema unique must be an array of field groups.');
  const unique = new Map();
  for (const [name, rule] of fields) {
    if (rule.unique) unique.set(JSON.stringify([name]), [name]);
  }
  for (const group of groups) {
    if (!Array.isArray(group) || !group.length || new Set(group).size !== group.length) {
      schemaError('Each unique group must contain distinct field names.');
    }
    if ([...group].some((name) => !fields.has(name))) {
      schemaError('Unique groups must reference defined scalar fields.');
    }
    unique.set(JSON.stringify([...group].sort()), [...group]);
  }
  for (const group of unique.values()) {
    if (group.some((name) => !fields.has(name) || fields.get(name).type === 'array')) {
      schemaError('Unique groups must reference defined scalar fields.');
    }
  }
  return { fields, unique: [...unique.values()] };
}
