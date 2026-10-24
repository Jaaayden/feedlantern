import type { FeedLanternError } from './errors.js';
import { t } from './messages.js';

export type OutputMode = 'json' | 'pretty' | 'table';

/** Rows and columns for `--table`; `rows` is the key holding the list ('' for a top-level array). */
export interface TableSpec { rows: string; columns: string[] }

function get(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.length > 3 ? `[${value.length}]` : value.map(cell).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s+/g, ' ');
}

/** Terminal columns: CJK and other wide characters take two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x1f300) ? 2 : 1;
  }
  return width;
}

function truncate(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char) > max - 1) break;
    out += char;
  }
  return `${out}…`;
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

export function renderTable(rows: unknown[], columns: string[], maxWidth = 48): string {
  if (!rows.length) return t('output.empty');
  const cells = rows.map(row => columns.map(column => truncate(cell(get(row, column)), maxWidth)));
  const widths = columns.map((column, index) => Math.max(displayWidth(column), ...cells.map(row => displayWidth(row[index]))));
  const line = (values: string[]) => values.map((value, index) => pad(value, widths[index])).join('  ').trimEnd();
  return [line(columns), line(widths.map(width => '-'.repeat(width))), ...cells.map(line)].join('\n');
}

/** Scalars of an object as `key  value` lines, for `--table` on a single record. */
function renderRecord(value: Record<string, unknown>): string {
  const entries = Object.entries(value).filter(([, entry]) => entry === null || typeof entry !== 'object' || Array.isArray(entry));
  const width = Math.max(...entries.map(([key]) => displayWidth(key)), 0);
  return entries.map(([key, entry]) => `${pad(key, width)}  ${truncate(cell(entry), 100)}`).join('\n');
}

export function formatResult(result: unknown, mode: OutputMode, table?: TableSpec): string {
  if (mode === 'table') {
    const rows = table ? (table.rows ? get(result, table.rows) : result) : Array.isArray(result) ? result : undefined;
    if (Array.isArray(rows)) {
      const columns = table?.columns ?? [...new Set(rows.flatMap(row => row && typeof row === 'object' ? Object.keys(row).filter(key => typeof (row as Record<string, unknown>)[key] !== 'object') : []))].slice(0, 8);
      const head = result && typeof result === 'object' && !Array.isArray(result) ? renderRecord(Object.fromEntries(Object.entries(result).filter(([key]) => key !== table?.rows))) : '';
      return [head, renderTable(rows, columns)].filter(Boolean).join('\n\n');
    }
    if (result && typeof result === 'object') return renderRecord(result as Record<string, unknown>);
    return String(result);
  }
  return mode === 'pretty' ? JSON.stringify(result, null, 2) : JSON.stringify(result);
}

export function formatError(error: FeedLanternError, mode: OutputMode): string {
  if (mode === 'table') {
    return [
      t('output.errorLine', { code: error.code, status: error.status || '-', message: error.message }),
      error.hint ? t('output.hintLine', { hint: error.hint }) : '',
    ].filter(Boolean).join('\n');
  }
  const body = { error: error.toJSON() };
  return mode === 'pretty' ? JSON.stringify(body, null, 2) : JSON.stringify(body);
}
