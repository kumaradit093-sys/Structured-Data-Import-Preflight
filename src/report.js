function safe(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) =>
    '\\u{' + character.codePointAt(0).toString(16) + '}');
}

function location({ recordIndex, line }) {
  return [
    recordIndex === undefined ? '' : `record ${recordIndex}`,
    line === undefined ? '' : `line ${line}`,
  ].filter(Boolean).join(', ');
}

/**
 * Format a structured preflight report for terminal display.
 * @param {object} report Report returned by preflightFile or preflightData.
 * @returns {string} Multiline report.
 */
export function formatReport(report) {
  const { totalRecords, validRecords, invalidRecords, errors, warnings } = report.summary;
  const lines = [
    `Preflight ${report.ok ? 'passed' : 'failed'} for ${safe(report.file ?? 'in-memory data')} (${report.format})`,
    `${totalRecords} records, ${validRecords} valid, ${invalidRecords} invalid, ${errors} errors, ${warnings} warnings`,
  ];
  for (const issue of report.issues) {
    const details = [
      location(issue),
      issue.column === undefined ? '' : `column ${issue.column}`,
      ...(issue.fields ?? (issue.field === undefined ? [] : [issue.field])).map((field) => JSON.stringify(field)),
    ].filter(Boolean).join(', ');
    const first = issue.firstOccurrence ? ` First occurrence at ${location(issue.firstOccurrence)}.` : '';
    const expected = issue.expected === undefined ? '' : ` Expected ${JSON.stringify(issue.expected)}.`;
    lines.push(safe(`${issue.severity.toUpperCase()} ${issue.code}${details ? ` (${details})` : ''} — ${issue.message}${expected}${first}`));
  }
  if (report.omittedIssues) lines.push(`${report.omittedIssues} additional issues omitted.`);
  return lines.join('\n');
}
