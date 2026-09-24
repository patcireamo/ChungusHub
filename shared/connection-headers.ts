/**
 * Extra HTTP headers a bring-your-own connection sends with every request, checked by one set
 * of rules on both sides. A header fetch cannot send throws at request time, so one let through
 * here surfaces as every generation on the connection failing instead of a line under the field.
 */

export type ConnectionHeaders = Record<string, string>;

export interface HeaderRow {
	name: string;
	value: string;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// What fetch accepts in a value: a byte string with no NUL, CR or LF.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

function pairProblem(name: string, value: string): string | null {
	if (!HEADER_NAME.test(name)) return `"${name}" is not a valid header name.`;
	if (!HEADER_VALUE.test(value)) return `the value of "${name}" holds characters a header cannot carry.`;
	return null;
}

/** The editor's rows as headers to save, or the first thing wrong with them. A row left
 *  wholly blank is a row still being filled in and is skipped. */
export function readHeaderRows(rows: HeaderRow[]): { headers: ConnectionHeaders } | { error: string } {
	const headers: ConnectionHeaders = {};
	const seen = new Set<string>();
	for (const row of rows) {
		const name = row.name.trim();
		const value = row.value.trim();
		if (!name && !value) continue;
		if (!name) return { error: 'a header has a value but no name.' };
		const problem = pairProblem(name, value);
		if (problem) return { error: problem };
		if (seen.has(name.toLowerCase())) return { error: `"${name}" is named twice.` };
		seen.add(name.toLowerCase());
		headers[name] = value;
	}
	return { headers };
}

/** A stored or received header set, checked whole. Throws naming the problem, because HTTP
 *  names are case-insensitive and two spellings of one name would be sent as one garbled header. */
export function checkHeaders(value: unknown): ConnectionHeaders {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Connection headers must be an object of names to values');
	}
	const seen = new Set<string>();
	for (const [name, v] of Object.entries(value)) {
		if (typeof v !== 'string') throw new Error(`Connection header "${name}" has a value that is not text`);
		const problem = pairProblem(name, v) ?? (seen.has(name.toLowerCase()) ? `"${name}" is named twice.` : null);
		if (problem) throw new Error(`Connection headers: ${problem}`);
		seen.add(name.toLowerCase());
	}
	return value as ConnectionHeaders;
}
