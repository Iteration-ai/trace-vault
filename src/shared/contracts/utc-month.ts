// The calendar month (UTC) an instant falls in, as its first day.
export function utcMonthStart(now: Date): string {
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
