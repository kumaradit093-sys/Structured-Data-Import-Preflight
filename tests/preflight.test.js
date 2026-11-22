import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { formatReport, preflightData, preflightFile } from 'data-import-preflight';

const idSchema = { fields: { id: { type: 'integer', required: true, unique: true } } };
const pairSchema = { fields: { ...idSchema.fields, name: { type: 'string', required: true } } };
const codes = (report) => report.issues.map(({ code }) => code);

async function fixture(t, content, filename) {
  const folder = await mkdtemp(join(tmpdir(), 'preflight-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, filename);
  await writeFile(file, content);
  return file;
}

const csvCases = [
  ['valid CSV', 'id,name\n1,Ana\n', [], { validRecords: 1 }],
  ['missing required column', 'id\n1\n', ['MISSING_COLUMN', 'MISSING_REQUIRED_FIELD']],
  ['unexpected column warns', 'id,name,extra\n1,Ana,x\n', ['UNEXPECTED_FIELD'], { warnings: 1, errors: 0 }],
  ['strict unexpected column', 'id,name,extra\n1,Ana,x\n', ['UNEXPECTED_FIELD'], { errors: 1 }, { strictColumns: true }],
  ['ignore unexpected column', 'id,name,extra\n1,Ana,x\n', [], {}, { unexpectedColumns: 'ignore' }],
  ['duplicate header', 'id,name,name\n1,Ana,x\n', ['DUPLICATE_CSV_HEADER']],
  ['empty header', 'id,name,\n1,Ana,x\n', ['EMPTY_CSV_HEADER']],
  ['empty record', 'id,name\n,\n', ['EMPTY_RECORD', 'MISSING_REQUIRED_FIELD', 'MISSING_REQUIRED_FIELD']],
  ['short row', 'id,name\n1\n', ['CSV_COLUMN_COUNT', 'MISSING_REQUIRED_FIELD']],
  ['extra cell', 'id,name\n1,Ana,x\n', ['CSV_COLUMN_COUNT']],
  ['quoted comma', 'id,name\n1,"Ana, Jr"\n', []],
  ['escaped quotes', 'id,name\n1,"Ana ""A"""\n', []],
  ['UTF-8 BOM', '\ufeffid,name\n1,Élodie\n', []],
  ['custom delimiter', 'id;name\n1;Ana\n', [], {}, { delimiter: ';' }],
  ['malformed CSV', 'id,name\n1,"Ana\n', ['MALFORMED_CSV'], { totalRecords: 0 }],
  ['empty file', '', ['MISSING_CSV_HEADER']],
  ['header only', 'id,name\n', [], { totalRecords: 0 }],
];

for (const [name, input, expected, counts = {}, options] of csvCases) {
  test(name, async (t) => {
    const file = await fixture(t, input, 'records.csv');
    const report = await preflightFile(file, pairSchema, options);
    assert.deepEqual(codes(report), expected);
    for (const [key, value] of Object.entries(counts)) assert.equal(report.summary[key], value);
  });
}

test('CSV multiline and blank rows have distinct record and physical line numbers', async (t) => {
  const input = 'id,name\r\n1,"first\r\nsecond"\r\n\r\n2,\r\n';
  const file = await fixture(t, input, 'records.csv');
  const report = await preflightFile(file, pairSchema);
  assert.equal(report.summary.totalRecords, 3);
  assert.deepEqual(report.issues.map(({ recordIndex, line }) => [recordIndex, line]), [
    [2, 4], [2, 4], [2, 4], [2, 4], [3, 5],
  ]);
  assert.equal(await readFile(file, 'utf8'), input);
});

test('CSV numeric and Boolean comparison values are normalized for rules and uniqueness', async (t) => {
  const file = await fixture(t, 'id,n,b\n01, 1.5e2 ,true\n1,0x11,TRUE\n20.5,2,false\n', 'records.csv');
  const schema = { fields: { ...idSchema.fields, n: { type: 'number', min: 2 }, b: { type: 'boolean' } } };
  const report = await preflightFile(file, schema);
  assert.deepEqual(codes(report), ['INVALID_TYPE', 'INVALID_TYPE', 'DUPLICATE_VALUE', 'INVALID_TYPE']);
  assert.deepEqual(report.issues[2].firstOccurrence, { recordIndex: 1, line: 2 });
});

test('CSV preserves completed records before a syntax error', async (t) => {
  const file = await fixture(t, 'id\nabc\n"unfinished', 'records.csv');
  const report = await preflightFile(file, idSchema);
  assert.deepEqual(codes(report), ['INVALID_TYPE', 'MALFORMED_CSV']);
  assert.equal(report.summary.totalRecords, 1);
});

const jsonCases = [
  ['valid JSON with BOM', '\ufeff[{"id":1}]', [], 1],
  ['invalid JSON', '[{"id":]', ['INVALID_JSON'], 0],
  ['invalid root', '{"id":1}', ['INVALID_JSON_ROOT'], 0],
  ['empty JSON array', '[]', [], 0],
  ['non-object items', '[0,null,[],{"id":1}]', Array(3).fill('INVALID_RECORD'), 4],
  ['empty JSON object', '[{}]', ['EMPTY_RECORD', 'MISSING_REQUIRED_FIELD'], 1],
  ['missing JSON field', '[{"other":1}]', ['UNEXPECTED_FIELD', 'MISSING_REQUIRED_FIELD'], 1],
  ['unexpected JSON field', '[{"id":1,"other":1}]', ['UNEXPECTED_FIELD'], 1],
  ['JSON strings are not numeric values', '[{"id":"1"}]', ['INVALID_TYPE'], 1],
];

for (const [name, input, expected, count] of jsonCases) {
  test(name, async (t) => {
    const file = await fixture(t, input, 'records.json');
    const report = await preflightFile(file, idSchema);
    assert.deepEqual(codes(report), expected);
    assert.equal(report.summary.totalRecords, count);
  });
}

const ruleCases = [
  ['required properties distinguish absent, undefined, empty and whitespace', { type: 'string', required: true },
    [{ tag: 1 }, { value: undefined }, { value: '' }, { value: '   ' }], Array(4).fill('MISSING_REQUIRED_FIELD')],
  ['nullable satisfies required', { type: 'string', required: true, nullable: true }, [{ value: null }], []],
  ['null needs permission on optional fields', { type: 'number' }, [{ value: null }], ['NULL_NOT_ALLOWED']],
  ['empty string options are independent', { type: 'string', required: true, allowEmpty: true },
    [{ value: '' }, { value: ' ' }], ['MISSING_REQUIRED_FIELD']],
  ['whitespace can be explicitly allowed', { type: 'string', required: true, allowWhitespace: true }, [{ value: ' ' }], []],
  ['optional blanks are skipped', { type: 'integer', min: 1 }, [{ value: '' }, { value: ' ' }], []],
  ['number must be finite', { type: 'number' }, [Infinity, NaN, 1.2].map((value) => ({ value })), ['INVALID_TYPE', 'INVALID_TYPE']],
  ['integer must be safe and integral', { type: 'integer' }, [1.2, 2 ** 53, -5].map((value) => ({ value })), ['INVALID_TYPE', 'INVALID_TYPE']],
  ['JSON boolean requires actual boolean', { type: 'boolean' }, [true, false, 'false', 0].map((value) => ({ value })), ['INVALID_TYPE', 'INVALID_TYPE']],
  ['date validation rejects ambiguous and nonexistent dates', { type: 'date' },
    ['2024-02-29', '2025-02-29', '01/02/25', '2020-01-01T00:00:00Z'].map((value) => ({ value })), Array(3).fill('INVALID_TYPE')],
  ['date and numeric bounds are inclusive', { type: 'date', min: '2020-01-01', max: '2020-12-31' },
    ['2019-12-31', '2020-01-01', '2020-12-31', '2021-01-01'].map((value) => ({ value })), Array(2).fill('CONSTRAINT_VIOLATION')],
  ['numeric bounds and enum collect independent issues', { type: 'number', min: 2, max: 5, enum: [2, 5] },
    [1, 2, 5, 6].map((value) => ({ value })), Array(4).fill('CONSTRAINT_VIOLATION')],
  ['string length, enum and pattern constraints', { type: 'string', minLength: 2, maxLength: 3, pattern: /^[A-Z]+$/g, enum: ['AB'] },
    ['a', 'AB', 'AB', 'ABCD'].map((value) => ({ value })), Array(5).fill('CONSTRAINT_VIOLATION')],
  ['array length constraint', { type: 'array', minLength: 1, maxLength: 2 },
    [[], [{ toString: null }], [1, 2, 3], 'x'].map((value) => ({ value })),
    ['CONSTRAINT_VIOLATION', 'CONSTRAINT_VIOLATION', 'INVALID_TYPE']],
  ['custom validators handle throws and async results', { type: 'integer', validate(value) {
    if (value === 3) throw new Error('Private data');
    if (value === 4) return Promise.reject(new Error('Private data'));
    return value === 1 || 'Value must be one.';
  } }, [1, 2, 3, 4].map((value) => ({ value })),
  ['CUSTOM_VALIDATION_FAILED', 'CUSTOM_VALIDATOR_ERROR', 'INVALID_CUSTOM_RESULT']],
];

for (const [name, rule, records, expected] of ruleCases) {
  test(name, () => {
    const report = preflightData(records, { fields: { value: rule } }, { unexpectedColumns: 'ignore' });
    assert.deepEqual(codes(report), expected);
    if (name.startsWith('required properties')) {
      assert.deepEqual(report.issues.map(({ reason }) => reason), ['missing', 'undefined', 'empty', 'whitespace']);
    }
  });
}

test('composite uniqueness uses complete tuples, skips blanks and nulls, and references the first record', () => {
  const schema = {
    fields: {
      a: { type: 'string', nullable: true, allowEmpty: true },
      b: { type: 'string' },
    },
    unique: [['a', 'b'], ['b', 'a']],
  };
  const records = [
    { a: 'x|y', b: 'z' }, { a: 'x', b: 'y|z' }, { a: '', b: 'z' }, { a: '', b: 'z' },
    { a: null, b: 'z' }, { a: null, b: 'z' }, { a: 'x|y', b: 'z' },
  ];
  const report = preflightData(records, schema);
  assert.deepEqual(codes(report), ['DUPLICATE_VALUE']);
  assert.deepEqual(report.issues[0].firstOccurrence, { recordIndex: 1 });
  assert.equal(report.issues[0].recordIndex, 7);
  assert.equal(report.summary.validRecords, 6);
});

test('caps issue display while tracking totals, warning counts and first occurrence', () => {
  const records = [{ id: '1', extra: 2 }, { id: 2 }, { id: 2 }, { id: 2 }];
  const report = preflightData(records, idSchema, { maxIssues: 1 });
  assert.deepEqual(report.summary, { totalRecords: 4, validRecords: 1, invalidRecords: 3, errors: 3, warnings: 1 });
  assert.equal(report.ok, false);
  assert.equal(report.omittedIssues, 3);
  assert.equal(report.issues.length, 1);
  assert.match(formatReport(report), /3 additional issues omitted/u);
});

test('custom callback receives comparable value and raw frozen record without mutation by engine', () => {
  const record = Object.freeze({ id: 1, tags: Object.freeze(['test']) });
  const records = Object.freeze([record]);
  const regex = /test/g;
  regex.lastIndex = 3;
  const schema = { fields: {
    id: { type: 'integer', validate(value, source, context) {
      return value === 1 && source === record && context.recordIndex === 1 && context.format === 'json';
    } },
    tags: { type: 'array' },
    other: { type: 'string', pattern: regex },
  } };
  assert.equal(preflightData(records, schema).ok, true);
  assert.deepEqual(records, [{ id: 1, tags: ['test'] }]);
  assert.equal(regex.lastIndex, 3);
});

test('field values are absent from built-in reports and terminal control characters are escaped', () => {
  const report = preflightData([{ id: 'private@example.com', ['extra\u001b']: 1 }], idSchema);
  assert.doesNotMatch(JSON.stringify(report), /private@example.com/u);
  assert.equal(formatReport(report).includes('\u001b'), false);
});

test('missing file throws a coded exception', async (t) => {
  const file = await fixture(t, '[]', 'records.json');
  await assert.rejects(preflightFile(file + '.missing', idSchema, { format: 'json' }), { code: 'FILE_NOT_FOUND' });
});

test('unsupported extension and explicit overrides', async (t) => {
  const file = await fixture(t, '[{"id":1}]', 'records.txt');
  await assert.rejects(preflightFile(file, idSchema), { code: 'UNSUPPORTED_FORMAT' });
  assert.equal((await preflightFile(file, idSchema, { format: 'json' })).ok, true);
});

test('invalid options throw a coded exception', () => {
  assert.throws(() => preflightData([], idSchema, { maxIssues: -1 }), { code: 'INVALID_OPTIONS' });
});

test('bad schemas throw coded exceptions before validation', () => {
  for (const schema of [{}, { fields: { id: { type: 'other' } } },
    { fields: { id: { type: 'string', pattern: '[' } } }, { ...idSchema, unique: [['missing']] },
    { fields: { id: { type: 'number', min: 5, max: 2 } } }]) {
    assert.throws(() => preflightData([], schema), { code: 'INVALID_SCHEMA' });
  }
});

test('file-size limit counts bytes including multibyte text', async (t) => {
  const input = 'id,name\n1,É\n';
  const file = await fixture(t, input, 'records.csv');
  await assert.rejects(preflightFile(file, pairSchema, { maxFileSize: input.length }), { code: 'FILE_TOO_LARGE' });
  assert.equal((await preflightFile(file, pairSchema, { maxFileSize: Buffer.byteLength(input) })).ok, true);
});

for (const format of ['json', 'csv']) {
  test(`invalid UTF-8 in ${format} throws a coded exception`, async (t) => {
    const file = await fixture(t, Buffer.from([0xff]), 'records.' + format);
    await assert.rejects(preflightFile(file, idSchema), { code: 'INVALID_ENCODING' });
  });
}

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function runCli(...args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

test('CLI exits 0 and emits JSON for valid input', async (t) => {
  const file = await fixture(t, '[{"id":1}]', 'records.json');
  const schema = await fixture(t, JSON.stringify(idSchema), 'schema.json');
  const result = runCli('--file', file, '--schema', schema, '--output', 'json');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('CLI exits 1 for validation and defaults to pretty output', async (t) => {
  const file = await fixture(t, '[{"id":"1"}]', 'records.json');
  const schema = await fixture(t, JSON.stringify(idSchema), 'schema.json');
  const result = runCli('--file', file, '--schema', schema);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /record 1, "id"/u);
});

test('CLI exits 2 for parsing even when max-issues hides the error', async (t) => {
  const file = await fixture(t, 'id\n1,2\n', 'records.csv');
  const schema = await fixture(t, JSON.stringify(idSchema), 'schema.json');
  const result = runCli('--file', file, '--schema', schema, '--max-issues', '0', '--output', 'json');
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).hasParsingErrors, true);
  assert.deepEqual(JSON.parse(result.stdout).issues, []);
});

test('CLI exits 2 for invalid configuration and file errors', async (t) => {
  const schema = await fixture(t, JSON.stringify(idSchema), 'schema.json');
  assert.match(runCli('--file', 'missing.csv', '--schema', schema).stderr, /was not found/u);
  const invalid = runCli('--file', 'missing.csv', '--schema', schema, '--output', 'bogus');
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--output/u);
});

test('CLI help and version have successful exit statuses', () => {
  assert.match(runCli('--help').stdout, /Usage/u);
  assert.equal(runCli('--version').stdout.trim(), '0.1.0');
});
