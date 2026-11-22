# data-import-preflight

Validate CSV and JSON files against a schema before importing structured data. A preflight check surfaces missing values, invalid types, duplicate keys, and shape problems while the source file is still easy to correct. Use the structured report to gate an import or the CLI to diagnose a file by hand. Database access stays in your application.

## Formats and features

- UTF-8 CSV with optional BOM, configurable delimiter, quoted commas, escaped quotes, and multiline fields.
- UTF-8 JSON with optional BOM and a top-level array of plain objects.
- Field types, required and nullable values, built-in constraints, field and composite uniqueness, and synchronous JavaScript validation callbacks.
- File and record diagnostics, configurable handling of unexpected fields, a bounded issue list, and terminal or JSON output.

## Installation

Requires Node.js 18 or later and an ES module application. Once the package is published, install it with:

```sh
npm install data-import-preflight
```

From this checkout before publication, run `npm ci` and `npm pack`. Then install the resulting `data-import-preflight-0.1.0.tgz` in your application with `npm install /path/to/data-import-preflight-0.1.0.tgz`.

## JavaScript usage

The examples below use the files in [examples/](examples/). Run from the repository root with `npm ci` completed, or copy the example files into an application with the package installed.

### CSV example

```js
import { readFile } from 'node:fs/promises';
import { formatReport, preflightFile } from 'data-import-preflight';

const schema = JSON.parse(await readFile('./examples/schema.json', 'utf8'));
const report = await preflightFile('./examples/customers.csv', schema, {
  strictColumns: true,
});
console.log(formatReport(report));

if (!report.ok) {
  console.error('Import cancelled due to preflight errors.');
  process.exitCode = report.hasParsingErrors ? 2 : 1;
} else {
  console.log('Data passed preflight. The application can proceed to its import step.');
}
```

In the example CSV, Ankit's email is missing and Neha's age is text. The report shows records 3 and 4 and physical lines 4 and 5. Run the example from this checkout with `node examples/basic.js`.

### JSON example

```js
import { readFile } from 'node:fs/promises';
import { formatReport, preflightFile } from 'data-import-preflight';

const schema = JSON.parse(await readFile('./examples/schema.json', 'utf8'));
const report = await preflightFile('./examples/customers.json', schema);
console.log(formatReport(report));
```

Run the same example program on JSON with `node examples/basic.js examples/customers.json`. Use `preflightData(records, schema, options)` for already parsed arrays. It returns the same report synchronously, with `file: null` and JSON type semantics.

## Schema configuration

```json
{
  "fields": {
    "id": { "type": "integer", "required": true, "unique": true },
    "email": { "type": "string", "required": true, "unique": true },
    "name": { "type": "string", "minLength": 2, "maxLength": 80 },
    "age": { "type": "integer", "min": 18, "max": 120 },
    "status": { "type": "string", "enum": ["active", "inactive"] }
  },
  "unique": [["name", "status"]]
}
```

The schema requires at least one named field. Field names and headers are case-sensitive, including their whitespace. Unknown schema keys or constraints incompatible with a type raise `INVALID_SCHEMA`. For CSV, absent required columns are errors and absent optional columns are warnings. In JSON, omitted optional keys are allowed. Unexpected CSV headers and JSON keys warn by default. Use `strictColumns: true` to treat them as errors or `unexpectedColumns: 'ignore'` to omit them in non-strict mode.

| Input condition | Optional field | Required field |
| --- | --- | --- |
| Missing own property | Skipped | Error with reason `missing` |
| Own property set to `undefined` (in memory) | Skipped | Error with reason `undefined` |
| Empty string | Skipped by default | Error with reason `empty` by default |
| Whitespace-only string | Skipped by default | Error with reason `whitespace` by default |
| Explicit JSON or in-memory `null` | Error unless `nullable: true` | Error unless `nullable: true` |

Set `allowEmpty: true` or `allowWhitespace: true` on a string field to allow the respective input through to string constraints. Nullable fields skip the other field checks for explicit nulls. CSV represents text, so a cell containing `null` is literal text. Blank CSV records and empty JSON objects produce an `EMPTY_RECORD` error even when every field is optional. An empty JSON array or a CSV with only valid headers represents zero records.

### Field types and constraints

| Type | JSON and in-memory values | CSV values | Constraints |
| --- | --- | --- | --- |
| `string` | String | Original cell text | `minLength`, `maxLength`, `pattern`, `enum` |
| `number` | Finite number | Signed decimal or scientific notation | `min`, `max`, `enum` |
| `integer` | Safe integer | Signed base-10 digits within the safe integer range | `min`, `max`, `enum` |
| `boolean` | Boolean | Lowercase `true` or `false` | — |
| `date` | Calendar date string in `YYYY-MM-DD` | Same format | `min`, `max` |
| `array` | Array | Requires JSON | `minLength`, `maxLength` |

Bounds are inclusive, string lengths use JavaScript UTF-16 code units, and patterns accept JavaScript regular expressions or regex source strings. Use a source string in a CLI schema. Enums compare typed values exactly. CSV trims surrounding whitespace for numeric, Boolean, and date comparisons. String comparisons use the original text. Dates must exist on the calendar and use the date-only format.

### Uniqueness

Use `unique: true` on a scalar field or add field groups under the top-level `unique` array. A duplicate issue belongs to the later record and carries the first occurrence location. Values compare with their validated type, so CSV integers `01` and `1` match. Strings compare case-sensitively. Any missing, blank, null, or type-invalid member skips the tuple. Values of the correct type still participate when they violate a constraint such as `min`.

### Custom validation

```js
import { preflightData } from 'data-import-preflight';

const schema = {
  fields: {
    age: {
      type: 'integer',
      validate(value, record, context) {
        return value >= 18 || `Record ${context.recordIndex} requires an adult customer.`;
      },
    },
  },
};
console.log(preflightData([{ age: 17 }, { age: 22 }], schema).issues);
```

The callback receives the comparable value, original record, and context with `field`, `format`, `recordIndex`, and CSV `line` when available. Treat the record and value as read-only. Return `true` or a nonempty issue message. Exceptions and unsupported return values become issues, and exception messages are suppressed. Custom messages appear in reports, so keep source values out of them. CLI schemas support built-in constraints.

### API options

| Option | Default | Effect |
| --- | --- | --- |
| `format` | Extension, case-insensitive | Override with `csv` or `json`. In-memory validation uses JSON rules. |
| `delimiter` | `,` | CSV field separator. Supports tabs and multicharacter delimiters. |
| `strictColumns` | `false` | Report unexpected fields as errors. |
| `unexpectedColumns` | `warn` | Use `ignore` to suppress non-strict unexpected-field warnings. |
| `maxFileSize` | 10 MiB | Positive safe integer byte limit for data files. |
| `maxIssues` | 100 | Nonnegative safe integer giving the maximum stored issues. |

## CLI

```sh
npx data-import-preflight --file ./examples/customers.csv --schema ./examples/schema.json
npx data-import-preflight --file ./examples/customers.json --schema ./examples/schema.json --output json
```

From the source checkout, substitute `node src/cli.js` for `npx data-import-preflight`. Use `--format csv|json` to override detection, `--output pretty|json` to select report style, and `--max-issues N` to limit displayed issues. The CLI supports `--help` and `--version`. Its JSON schema file has a 1 MiB limit.

| Exit | Meaning |
| --- | --- |
| 0 | Validation passes, possibly with warnings. Also used by help and version. |
| 1 | At least one data validation error. |
| 2 | File, parsing, argument, or schema error. |

Reports go to stdout. File and configuration exceptions print a diagnostic to stderr and exit 2.

## Report structure

```json
{
  "ok": false,
  "file": "customers.csv",
  "format": "csv",
  "summary": {
    "totalRecords": 1,
    "validRecords": 0,
    "invalidRecords": 1,
    "errors": 1,
    "warnings": 0
  },
  "hasParsingErrors": false,
  "omittedIssues": 0,
  "issues": [
    {
      "code": "MISSING_REQUIRED_FIELD",
      "severity": "error",
      "category": "validation",
      "message": "Required value is missing.",
      "recordIndex": 1,
      "line": 2,
      "field": "email",
      "reason": "empty"
    }
  ]
}
```

`ok` is true when there are zero errors. Records are numbered from 1, excluding the CSV header. For CSV, `line` is the one-based physical line where the header or record starts, including after a multiline field. A fatal CSV syntax issue points to the failing record when its index is known, and the summary covers completed records. Header issues affect overall status without changing record counts. Warning-only records count as valid. Issue limits apply to stored issues, while summaries, parsing status, and duplicate tracking cover the entire inspected input.

Issues can include a field name or composite field names, an expected condition, a CSV column position, or first occurrence location. Reports include paths and field names. Built-in diagnostics omit raw field values.

### Error codes

| Category | Codes |
| --- | --- |
| File or configuration exceptions (`PreflightError.code`) | `INVALID_FILE_PATH`, `FILE_NOT_FOUND`, `FILE_READ_ERROR`, `FILE_TOO_LARGE`, `INVALID_ENCODING`, `UNSUPPORTED_FORMAT`, `INVALID_OPTIONS`, `INVALID_SCHEMA` |
| Parsing issues | `INVALID_JSON`, `INVALID_JSON_ROOT`, `MISSING_CSV_HEADER`, `EMPTY_CSV_HEADER`, `DUPLICATE_CSV_HEADER`, `CSV_COLUMN_COUNT`, `MALFORMED_CSV` |
| Structural and field issues | `MISSING_COLUMN`, `UNEXPECTED_FIELD`, `EMPTY_RECORD`, `INVALID_RECORD`, `MISSING_REQUIRED_FIELD`, `NULL_NOT_ALLOWED`, `INVALID_TYPE`, `CONSTRAINT_VIOLATION`, `DUPLICATE_VALUE` |
| Callback issues | `CUSTOM_VALIDATION_FAILED`, `CUSTOM_VALIDATOR_ERROR`, `INVALID_CUSTOM_RESULT` |

## Performance and limitations

CSV is streamed and checked one record at a time. JSON uses native `JSON.parse` and holds the decoded input and parsed records in memory during parsing. The byte limit applies to both. Uniqueness tracking retains a key and location for each distinct checked value or tuple. Set file and issue limits appropriate to your process memory and use trusted schemas with efficient patterns and callbacks.

Supported data shapes are CSV tables and JSON arrays of objects. JSON arrays used as fields support length rules. Native JSON parsing keeps the last value for duplicate object keys. Fatal CSV syntax errors stop parsing. Format support is limited to CSV and JSON, and the package leaves source files unchanged.

## Database-import workflow

Validate the same file your importer will read and proceed only when `report.ok` is true. Keep permissions, transactions, and database-specific error handling in the importer. A passing report can catch schema and in-file data problems early. Database-specific constraints, permissions, and existing database state can still cause an insert to fail.

## Contributing

Use Node.js 18.18 or later for the development tools. Run `npm ci`, `npm test`, `npm run lint`, and `npm pack --dry-run`. Use the built-in Node.js test runner for new checks and exercise the CLI with the files in `examples/`.

## License

[MIT](LICENSE).
