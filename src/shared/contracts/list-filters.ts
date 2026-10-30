export const RANGE_PRESETS = ["24h", "7d", "30d", "90d"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABELS = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
} as const satisfies Record<RangePreset, string>;

const RANGE_PRESET_MS = {
	"24h": 86_400_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
	"90d": 90 * 86_400_000,
} as const satisfies Record<RangePreset, number>;

// The range value that asks a list with a default range for every time.
export const ALL_TIME_RANGE = "all" as const;

export function isRangePreset(value: string): value is RangePreset {
	return (RANGE_PRESETS as readonly string[]).includes(value);
}

export const MAX_FILTER_VALUES = 25;

export type SetFilter<T extends string = string> = Readonly<{
	operator: "is" | "not";
	values: readonly T[];
}>;

// Raw strings exactly as they appear in a list URL; each feature's application
// layer parses and validates them.
export type FilterUrlState = Readonly<{
	search: string | null;
	range: string | null;
	from: string | null;
	before: string | null;
	parent: string | null;
	sets: Readonly<Record<string, SetFilter>>;
}>;

export type FilterUrlReader = Readonly<{
	get(key: string): string | null;
	getAll(key: string): readonly string[];
}>;

export type FilterOption = Readonly<{
	value: string;
	label: string;
	detail: string | null;
	count: number | null;
}>;

function operatorKey(kind: string): string {
	return `${kind}_op`;
}

function nonEmpty(value: string | null): string | null {
	return value === null || value === "" ? null : value;
}

export function filterUrlReader(
	params: Readonly<Record<string, string | string[] | undefined>>,
): FilterUrlReader {
	const all = (key: string): readonly string[] => {
		const value = params[key];
		if (value === undefined) return [];
		return Array.isArray(value) ? value : [value];
	};
	return { get: (key) => all(key)[0] ?? null, getAll: all };
}

export function readFilterUrl(
	reader: FilterUrlReader,
	kinds: readonly string[],
): FilterUrlState {
	return {
		search: nonEmpty(reader.get("q")),
		range: nonEmpty(reader.get("range")),
		from: nonEmpty(reader.get("from")),
		before: nonEmpty(reader.get("before")),
		parent: nonEmpty(reader.get("parent")),
		sets: Object.fromEntries(
			kinds.map((kind) => [
				kind,
				{
					operator: reader.get(operatorKey(kind)) === "not" ? "not" : "is",
					values: [
						...new Set(reader.getAll(kind).filter((value) => value !== "")),
					],
				} satisfies SetFilter,
			]),
		),
	};
}

export function writeFilterUrl(
	query: URLSearchParams,
	state: FilterUrlState,
): URLSearchParams {
	for (const [key, value] of [
		["q", state.search],
		["range", state.range],
		["from", state.from],
		["before", state.before],
		["parent", state.parent],
	] as const) {
		if (value !== null) query.set(key, value);
	}
	for (const [kind, filter] of Object.entries(state.sets)) {
		for (const value of filter.values) query.append(kind, value);
		if (filter.values.length > 0 && filter.operator === "not") {
			query.set(operatorKey(kind), "not");
		}
	}
	return query;
}

export function hasActiveFilters(state: FilterUrlState): boolean {
	return (
		state.search !== null ||
		state.range !== null ||
		state.from !== null ||
		state.before !== null ||
		state.parent !== null ||
		Object.values(state.sets).some((filter) => filter.values.length > 0)
	);
}

const UTC_INSTANT_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;

export function parseUtcInstant(value: string): Date | null {
	if (!UTC_INSTANT_PATTERN.test(value)) return null;
	const instant = new Date(value);
	if (
		!Number.isFinite(instant.valueOf()) ||
		instant.toISOString().slice(0, 16) !== value.slice(0, 16)
	) {
		return null;
	}
	return instant;
}

export function rangePresetStart(range: RangePreset, now: Date): Date {
	return new Date(now.valueOf() - RANGE_PRESET_MS[range]);
}
