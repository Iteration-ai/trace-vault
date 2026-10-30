import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { rules as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";
import type { JsonValue, TraceEvent } from "iteration-trace-contracts";
import * as z from "zod";

// Secretlint profiles every rule run by default and keeps each timing entry,
// so a long-running collector's memory would grow without limit.
secretLintProfiler.setEnabled(false);

const REDACTED = "[REDACTED]";
const secretlintConfig = {
	rules: recommendedRules
		.filter(
			(rule) => rule.meta.id !== "@secretlint/secretlint-rule-filter-comments",
		)
		.map((rule) => ({ id: rule.meta.id, rule })),
};
const assignment =
	/\b([A-Za-z][A-Za-z0-9_-]{0,79})["']?\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"'`,;}&]+))/g;
const authorization =
	/\b(?:authorization|proxy-authorization)["']?\s*:\s*["']?(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]+={0,2})/gi;
const privateKey =
	/-----BEGIN ((?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

type Range = Readonly<{ start: number; end: number }>;

function normalizedKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.toLowerCase();
}

function sensitiveKey(key: string): boolean {
	const normalized = normalizedKey(key);
	if (/^(?:next_public|public|vite|react_app)_/.test(normalized)) return false;
	return (
		/(?:^|_)(?:secret|password|passwd|credential)(?:_|$)/.test(normalized) ||
		/(?:^|_)(?:api_key|private_key|database_url|db_url|dsn|connection_string|authorization|proxy_authorization|auth_header|cookie|set_cookie|token)$/.test(
			normalized,
		)
	);
}

function placeholder(value: string): boolean {
	const trimmed = value.trim();
	return (
		trimmed === REDACTED ||
		/^(?:<[^>]+>|\$\{[^}]+\}|\*+|redacted|placeholder|example|changeme|undefined|null)$/i.test(
			trimmed,
		) ||
		/^(?:process\.env|env)\.[A-Za-z0-9_]+$/.test(trimmed)
	);
}

function addRange(
	ranges: Range[],
	start: number,
	end: number,
	length: number,
): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end > length ||
		start >= end
	) {
		throw new Error("Local trace secret scanner returned an invalid location.");
	}
	ranges.push({ start, end });
}

function textRanges(value: string): Range[] {
	const ranges: Range[] = [];
	for (const match of value.matchAll(assignment)) {
		const key = match[1];
		const candidate = match[2] ?? match[3] ?? match[4];
		if (
			key === undefined ||
			candidate === undefined ||
			candidate.length === 0 ||
			!sensitiveKey(key) ||
			placeholder(candidate) ||
			((normalizedKey(key) === "authorization" ||
				normalizedKey(key) === "proxy_authorization") &&
				/^(?:Bearer|Basic)$/i.test(candidate))
		)
			continue;
		const start = match.index + match[0].lastIndexOf(candidate);
		addRange(ranges, start, start + candidate.length, value.length);
	}
	for (const match of value.matchAll(authorization)) {
		const candidate = match[1];
		if (candidate === undefined || placeholder(candidate)) continue;
		const start = match.index + match[0].lastIndexOf(candidate);
		addRange(ranges, start, start + candidate.length, value.length);
	}
	for (const match of value.matchAll(privateKey)) {
		addRange(ranges, match.index, match.index + match[0].length, value.length);
	}
	return ranges;
}

function replaceRanges(value: string, ranges: Range[]): string {
	if (ranges.length === 0) return value;
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Range[] = [];
	for (const range of ranges) {
		const previous = merged.at(-1);
		if (previous !== undefined && range.start <= previous.end) {
			merged[merged.length - 1] = {
				start: previous.start,
				end: Math.max(previous.end, range.end),
			};
		} else merged.push(range);
	}
	let result = value;
	for (let index = merged.length - 1; index >= 0; index -= 1) {
		const range = merged[index];
		if (range === undefined) continue;
		result = `${result.slice(0, range.start)}${REDACTED}${result.slice(range.end)}`;
	}
	return result;
}

async function redactText(value: string): Promise<string> {
	if (value.length === 0 || value === REDACTED) return value;
	const ranges = textRanges(value);
	let result;
	try {
		result = await lintSource({
			source: {
				contentType: "text",
				content: value,
				filePath: "trace.txt",
				ext: "txt",
			},
			options: {
				maskSecrets: true,
				noPhysicFilePath: true,
				config: secretlintConfig,
			},
		});
	} catch {
		throw new Error(
			"Local trace secret scanning failed; the event was not queued.",
		);
	}
	for (const message of result.messages) {
		addRange(ranges, message.range[0], message.range[1], value.length);
	}
	return replaceRanges(value, ranges);
}

async function redactValue(
	value: JsonValue,
	cache: Map<string, Promise<string>>,
	force: boolean,
): Promise<JsonValue> {
	const parsedText = z.string().safeParse(value);
	if (parsedText.success) {
		const text = parsedText.data;
		if (force) return placeholder(text) ? text : REDACTED;
		let result = cache.get(text);
		if (result === undefined) {
			result = redactText(text);
			cache.set(text, result);
		}
		return result;
	}
	if (value === null || value === true || value === false) return value;
	const parsedNumber = z.number().safeParse(value);
	if (parsedNumber.success) return force ? REDACTED : parsedNumber.data;
	if (Array.isArray(value)) {
		const items = await Promise.all(
			value.map((item) => redactValue(item, cache, force)),
		);
		return items.every((item, index) => item === value[index]) ? value : items;
	}
	const record = value as Readonly<Record<string, JsonValue>>;
	const entries = await Promise.all(
		Object.entries(record).map(
			async ([key, item]) =>
				[
					key,
					await redactValue(item, cache, force || sensitiveKey(key)),
				] as const,
		),
	);
	return entries.every(([key, item]) => item === record[key])
		? value
		: Object.fromEntries(entries);
}

export async function redactTraceEvent(event: TraceEvent): Promise<TraceEvent> {
	const cache = new Map<string, Promise<string>>();
	if (event.payload.sourceType === "cursor_subagent_transcript") {
		const parsed = z.string().safeParse(event.payload.base64);
		if (!parsed.success)
			throw new Error("Cursor transcript has invalid encoded content.");
		const bytes = Buffer.from(parsed.data, "base64");
		if (bytes.toString("base64") !== parsed.data)
			throw new Error("Cursor transcript has invalid encoded content.");
		const raw = bytes.toString("latin1");
		const redacted = await redactText(raw);
		const { base64: _encoded, ...remaining } = event.payload;
		const payload = await redactValue(remaining, cache, false);
		return {
			...event,
			payload: {
				...(payload as TraceEvent["payload"]),
				base64:
					redacted === raw
						? parsed.data
						: Buffer.from(redacted, "latin1").toString("base64"),
			},
		};
	}
	const payload = await redactValue(event.payload, cache, false);
	return payload === event.payload
		? event
		: { ...event, payload: payload as TraceEvent["payload"] };
}
