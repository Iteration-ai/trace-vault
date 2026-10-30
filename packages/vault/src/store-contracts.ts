import type {
	VaultAccount as SharedVaultAccount,
	VaultCapturePolicy,
} from "iteration-trace-contracts";

export type VaultSource = SharedVaultAccount["source"];
export type VaultRole = "admin" | "member";
export type VaultAccount = SharedVaultAccount;
export type VaultPolicy = VaultCapturePolicy;
export type VaultCaller =
	| Readonly<{ kind: "session"; tokenHash: string }>
	| Readonly<{ kind: "device"; tokenHash: string }>;
export type VaultSessionToken = Readonly<{
	tokenHash: string;
	expiresAt: Date;
}>;
export type VaultIdentity = Readonly<{ email: string; name: string }>;
export type VaultMember = VaultIdentity &
	Readonly<{
		id: string;
		role: VaultRole;
		disabled: boolean;
		createdAt: Date;
	}>;
export type VaultSessionIdentity = Readonly<{
	memberId: string;
	source: VaultSource;
	sourceSessionId: string;
}>;
export type VaultPageRequest = Readonly<{ after?: string; limit?: number }>;
export type VaultPage<T> = Readonly<{ items: T[]; nextCursor: string | null }>;
export type VaultIngestResult = Readonly<{
	acceptedEventIds: string[];
	insertedCount: number;
}>;
export type VaultErrorCode =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "conflict"
	| "policy_changed"
	| "invalid_input"
	| "already_initialized";

export class VaultStoreError extends Error {
	readonly code: VaultErrorCode;
	constructor(code: VaultErrorCode, message: string) {
		super(message);
		this.name = "VaultStoreError";
		this.code = code;
	}
}
