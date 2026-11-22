import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TextDecoder } from 'node:util';
import { parse } from 'csv-parse';
import { PreflightError } from './errors.js';

function sizeError(limit) {
  return new PreflightError('FILE_TOO_LARGE', `Input exceeds the ${limit}-byte limit.`);
}

function decode(decoder, chunk, stream) {
  try {
    return decoder.decode(chunk, { stream });
  } catch {
    throw new PreflightError('INVALID_ENCODING', 'Input must be valid UTF-8.');
  }
}

// Check the actual byte count as well as the initial file size.
async function* readBytes(file, limit) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new PreflightError('FILE_READ_ERROR', 'Input path must be a regular file.');
    if (info.size > limit) throw sizeError(limit);
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length;
      if (bytes > limit) throw sizeError(limit);
      yield chunk;
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error.code === 'ENOENT') throw new PreflightError('FILE_NOT_FOUND', 'Input file was not found.');
    throw new PreflightError('FILE_READ_ERROR', 'Input file could not be read.');
  }
}

export async function readUtf8(file, limit) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  for await (const chunk of readBytes(file, limit)) chunks.push(decode(decoder, chunk, true));
  chunks.push(decode(decoder));
  return chunks.join('');
}

export async function readJson(file, limit, collector) {
  const input = await readUtf8(file, limit);
  let records;
  try {
    records = JSON.parse(input);
  } catch {
    collector.add('INVALID_JSON', 'Input contains malformed JSON.', { category: 'parsing' });
    return;
  }
  collector.json(records);
}

export async function readCsv(file, options, collector) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encodingCheck = new Transform({
    transform(chunk, encoding, callback) {
      try {
        decode(decoder, chunk, true);
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        decode(decoder);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
  let headers;
  let count = 0;
  let line = 1;
  const parser = parse({
    bom: true,
    delimiter: options.delimiter,
    relax_column_count: true,
    raw: true,
    on_record({ record, raw }) {
      if (!headers) {
        headers = record;
        collector.headers(record, line);
      } else {
        collector.csv(headers, record, ++count, line);
      }
      // The parser counts CR and LF separately inside quoted CRLF fields.
      // Raw record text lets us count each physical break exactly once.
      line += raw.match(/\r\n|\r|\n/gu)?.length ?? 0;
      return null;
    },
  });

  try {
    await pipeline(readBytes(file, options.maxFileSize), encodingCheck, parser);
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (!error.code?.startsWith('CSV_')) throw error;
    collector.add('MALFORMED_CSV', 'CSV syntax is invalid. Parsing stopped at this record.', {
      category: 'parsing',
      line,
      ...(headers ? { recordIndex: count + 1 } : {}),
    });
    return;
  }
  if (!headers) collector.add('MISSING_CSV_HEADER', 'CSV input has no header.', { category: 'parsing' });
}
