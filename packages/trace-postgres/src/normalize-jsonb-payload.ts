import type { JsonValue } from "iteration-trace-contracts";
import * as z from "zod";

const stringValue = z.string();
const unchangedScalar = z.union([z.number(), z.boolean(), z.null()]);
const unpairedSurrogate =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function normalizeJsonbText(value: string): string {
	return value
		.replaceAll("\u0000", "\uFFFD")
		.replace(unpairedSurrogate, "\uFFFD");
}

function normalizeString(value: string): string {
	return value
		.replaceAll("\u0000", String.raw`\u0000`)
		.replace(unpairedSurrogate, "\uFFFD");
}

function normalizeValue(value: JsonValue): JsonValue {
	if (stringValue.validate(value)) return normalizeString(value);
	if (Array.isArray(value)) {
		let normalized: JsonValue[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const original = value[index]!;
			const next = normalizeValue(original);
			if (normalized === undefined && next !== original) {
				normalized = value.slice(0, index);
			}
			normalized?.push(next);
		}
		return normalized ?? value;
	}
	if (unchangedScalar.validate(value)) return value;
	const entries = Object.entries(value);
	let normalizedEntries: [string, JsonValue][] | undefined;
	let changedKey = false;
	for (let index = 0; index < entries.length; index++) {
		const [key, nestedValue] = entries[index]!;
		const normalizedKey = normalizeString(key);
		const normalizedValue = normalizeValue(nestedValue);
		if (
			normalizedEntries === undefined &&
			(normalizedKey !== key || normalizedValue !== nestedValue)
		) {
			normalizedEntries = entries.slice(0, index);
		}
		if (normalizedKey !== key) changedKey = true;
		normalizedEntries?.push([normalizedKey, normalizedValue]);
	}
	if (normalizedEntries === undefined) return value;
	if (!changedKey) return Object.fromEntries(normalizedEntries);
	const originalKeys = new Set(entries.map(([key]) => key));
	const usedKeys = new Set<string>();
	const resolvedEntries = normalizedEntries.map(([key, nestedValue], index) => {
		let resolvedKey = key;
		if (
			key !== entries[index]![0] &&
			(originalKeys.has(key) || usedKeys.has(key))
		) {
			let suffix = 2;
			let candidate = `${key} [normalized key ${suffix}]`;
			while (originalKeys.has(candidate) || usedKeys.has(candidate)) {
				suffix++;
				candidate = `${key} [normalized key ${suffix}]`;
			}
			resolvedKey = candidate;
		}
		usedKeys.add(resolvedKey);
		return [resolvedKey, nestedValue] as const;
	});
	return Object.fromEntries(resolvedEntries);
}

export function normalizeJsonbPayload(
	payload: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
	return normalizeValue(payload) as Readonly<Record<string, JsonValue>>;
}
