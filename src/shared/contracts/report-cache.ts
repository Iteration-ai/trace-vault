export interface ReportCacheStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}
