import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
	canonicalRepository,
	permitsVaultCapture,
	type TraceEvent,
} from "iteration-trace-contracts";
import {
	deleteTraceSession,
	ingestTraceBatch,
	prepareTraceIngestRows,
} from "iteration-trace-postgres";
import { Pool } from "pg";
import * as z from "zod";
import { hashPassword, passwordSchema } from "./password.js";
import * as tables from "./schema.js";
import {
	type VaultAccount,
	type VaultCaller,
	type VaultIdentity,
	type VaultIngestResult,
	type VaultMember,
	type VaultPage,
	type VaultPageRequest,
	type VaultPolicy,
	type VaultRole,
	type VaultSessionIdentity,
	type VaultSessionToken,
	type VaultSource,
	VaultStoreError,
} from "./store-contracts.js";
import {
	eventFields,
	receiptJoin,
	saveTraceReceipts,
	sessionJoin,
	storageBatch,
	storageContext,
	storageSchema,
} from "./trace-storage.js";

type Database = ReturnType<typeof drizzle>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Actor = VaultMember & {
	device: typeof tables.devices.$inferSelect | null;
};
const memberFields = {
	id: tables.members.id,
	email: tables.members.email,
	name: tables.members.name,
	role: tables.members.role,
	disabled: tables.members.disabled,
	createdAt: tables.members.createdAt,
};
const deviceFields = {
	id: tables.devices.id,
	memberId: tables.devices.memberId,
	source: tables.devices.source,
	name: tables.devices.name,
	revoked: tables.devices.revoked,
	createdAt: tables.devices.createdAt,
};
const invitationFields = {
	id: tables.invitations.id,
	email: tables.invitations.email,
	name: tables.invitations.name,
	role: tables.invitations.role,
	expiresAt: tables.invitations.expiresAt,
	redeemedAt: tables.invitations.redeemedAt,
	revoked: tables.invitations.revoked,
};
const sessionFields = {
	id: tables.sessionIdentifiers.id,
	source: tables.sessionIdentifiers.source,
	sourceSessionId: tables.sessionIdentifiers.sourceSessionId,
	memberId: tables.sessionIdentifiers.memberId,
	contributorId: tables.sessionIdentifiers.memberId,
	contributorName: tables.members.name,
	title: sql<
		string | null
	>`coalesce(${tables.traceSessions.sourceTitle}, nullif(btrim(${tables.sessionIdentifiers.title}), ''), ${tables.traceSessions.firstUserMessagePreview})`,
	cwd: tables.traceSessions.sourceCwd,
	projectId: tables.sessionIdentifiers.projectId,
	repository: sql<
		string | null
	>`${tables.traceSessions.sourceRepositoryUrl}`.mapWith(
		(value: string | null) => (value ? canonicalRepository(value) : null),
	),
	lastReceivedAt: tables.traceSessions.lastReceivedAt,
	eventCount: tables.traceSessions.eventCount,
};
const uuidSchema = z.uuid();
const sessionCursorSchema = z
	.object({ at: z.iso.datetime(), id: uuidSchema })
	.strict();
const eventCursorSchema = z
	.object({ sequence: z.number().int(), eventId: z.string(), id: uuidSchema })
	.strict();
const duplicateErrorSchema = z.object({ code: z.literal("23505") });
function cursor<T>(
	value: string | undefined,
	schema: z.ZodType<T>,
): T | undefined {
	if (value === undefined) return undefined;
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16384)
			throw new Error();
		return schema.parse(
			JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
		);
	} catch {
		fail("invalid_input", "Invalid page cursor");
	}
}
function encodeCursor(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fail(
	code: ConstructorParameters<typeof VaultStoreError>[0],
	message: string,
): never {
	throw new VaultStoreError(code, message);
}
function hash(value: string): string {
	if (!/^[a-f0-9]{64}$/.test(value))
		fail("invalid_input", "Expected a SHA256 token hash");
	return value;
}
function email(value: string): string {
	return value.trim().toLowerCase();
}
function sessionToken(token: VaultSessionToken): VaultSessionToken {
	hash(token.tokenHash);
	if (
		!(token.expiresAt instanceof Date) ||
		!(token.expiresAt.getTime() > Date.now())
	) {
		fail("invalid_input", "Token expiry must be in the future");
	}
	return token;
}
function pagination(page: VaultPageRequest, composite = false) {
	const limit = page.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 200)
		fail("invalid_input", "Page limit must be 1–200");
	if (!composite && page.after && !uuidSchema.safeParse(page.after).success)
		fail("invalid_input", "Invalid page cursor");
	return { limit, after: page.after };
}
function paged<T extends { id: string }>(
	rows: T[],
	limit: number,
): VaultPage<T> {
	const items = rows.slice(0, limit);
	return {
		items,
		nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
	};
}
function own(actor: Actor, memberId: string) {
	if (actor.id !== memberId && actor.role !== "admin")
		fail("forbidden", "Owner or admin required");
}
function human(actor: Actor) {
	if (actor.device) fail("forbidden", "Member session required");
}
function admin(actor: Actor) {
	human(actor);
	if (actor.role !== "admin") fail("forbidden", "Admin required");
}
function sessionScope(identity: VaultSessionIdentity) {
	return and(
		eq(tables.sessionIdentifiers.memberId, identity.memberId),
		eq(tables.sessionIdentifiers.source, identity.source),
		eq(tables.sessionIdentifiers.sourceSessionId, identity.sourceSessionId),
	);
}
function eventScope(identity: VaultSessionIdentity) {
	return and(
		eq(tables.eventReceipts.memberId, identity.memberId),
		eq(tables.eventReceipts.source, identity.source),
		eq(tables.traceEvents.sessionId, identity.sourceSessionId),
	);
}

export class VaultStore {
	private readonly pool: Pool;
	private readonly database: Database;

	constructor(databaseUrl: string) {
		const parsed = z.url().safeParse(databaseUrl);
		if (!parsed.success || !/^postgres(?:ql)?:\/\//.test(parsed.data)) {
			fail("invalid_input", "An explicit PostgreSQL database URL is required");
		}
		const url = new URL(parsed.data);
		if (!url.hostname || url.pathname.length < 2)
			fail(
				"invalid_input",
				"Configure the database host and database name explicitly",
			);
		this.pool = new Pool({
			connectionString: databaseUrl,
			port: Number(url.port || 5432),
			max: 10,
			connectionTimeoutMillis: 5000,
			statement_timeout: 15000,
			lock_timeout: 5000,
			idle_in_transaction_session_timeout: 15000,
		});
		this.database = drizzle(this.pool);
	}

	async close(): Promise<void> {
		await this.pool.end();
	}

	async ready(): Promise<void> {
		await this.database.execute(sql`select 1`);
	}

	async status(): Promise<{
		initialized: boolean;
		name: string | null;
		id: string | null;
	}> {
		const [company] = await this.database
			.select({ id: tables.company.deploymentId, name: tables.company.name })
			.from(tables.company)
			.where(eq(tables.company.id, 1));
		return company
			? { initialized: true, ...company }
			: { initialized: false, name: null, id: null };
	}

	private async transaction<T>(
		operation: (tx: Transaction) => Promise<T>,
	): Promise<T> {
		try {
			return await this.database.transaction(operation);
		} catch (error) {
			const cause = error instanceof Error && error.cause ? error.cause : error;
			if (duplicateErrorSchema.safeParse(cause).success) {
				fail("conflict", "Identity or token already exists");
			}
			throw error;
		}
	}

	private async authorized<T>(
		caller: VaultCaller,
		write: boolean,
		operation: (
			tx: Transaction,
			actor: Actor,
			company: typeof tables.company.$inferSelect,
		) => Promise<T>,
	): Promise<T> {
		hash(caller.tokenHash);
		return this.transaction(async (tx) => {
			// Shared read locks permit concurrent browsing; exclusive mutations fence policy and revocation.
			const [company] = await tx
				.select()
				.from(tables.company)
				.where(eq(tables.company.id, 1))
				.for(write ? "update" : "share");
			if (!company) fail("unauthorized", "Vault is not initialized");
			let actor: Actor | undefined;
			if (caller.kind === "session") {
				const [row] = await tx
					.select(memberFields)
					.from(tables.members)
					.innerJoin(
						tables.authSessions,
						eq(tables.authSessions.memberId, tables.members.id),
					)
					.where(
						and(
							eq(tables.authSessions.tokenHash, caller.tokenHash),
							eq(tables.authSessions.revoked, false),
							gt(tables.authSessions.expiresAt, sql`clock_timestamp()`),
							eq(tables.members.disabled, false),
						),
					);
				if (row) actor = { ...row, device: null };
			} else {
				const [row] = await tx
					.select({ member: memberFields, device: tables.devices })
					.from(tables.members)
					.innerJoin(
						tables.devices,
						eq(tables.devices.memberId, tables.members.id),
					)
					.where(
						and(
							eq(tables.devices.tokenHash, caller.tokenHash),
							eq(tables.devices.revoked, false),
							eq(tables.members.disabled, false),
						),
					);
				if (row) actor = { ...row.member, device: row.device };
			}
			if (!actor)
				fail("unauthorized", "Credentials are expired, revoked, or inactive");
			return operation(tx, actor, company);
		});
	}

	private async audit(
		tx: Transaction,
		actorId: string | null,
		action: string,
		targetId: string,
	) {
		await tx.insert(tables.auditEntries).values({ actorId, action, targetId });
	}

	async initialize(
		name: string,
		initialAdmin: VaultIdentity & { passwordHash: string },
	): Promise<VaultMember> {
		return this.transaction(async (tx) => {
			const [created] = await tx
				.insert(tables.company)
				.values({ name })
				.onConflictDoNothing()
				.returning();
			if (!created) fail("already_initialized", "Vault is already initialized");
			const [member] = await tx
				.insert(tables.members)
				.values({
					...initialAdmin,
					email: email(initialAdmin.email),
					role: "admin",
				})
				.returning(memberFields);
			if (!member) fail("conflict", "Could not create initial administrator");
			await this.audit(tx, member.id, "company.initialized", "1");
			return member;
		});
	}

	async login(
		address: string,
		verifyPassword: (passwordHash: string) => Promise<boolean>,
		token: VaultSessionToken,
	): Promise<VaultMember> {
		sessionToken(token);
		return this.transaction(async (tx) => {
			await tx
				.select({ id: tables.company.id })
				.from(tables.company)
				.for("share");
			const [member] = await tx
				.select({ ...memberFields, passwordHash: tables.members.passwordHash })
				.from(tables.members)
				.where(
					and(
						eq(tables.members.email, email(address)),
						eq(tables.members.disabled, false),
					),
				);
			const verified = await verifyPassword(member?.passwordHash ?? "");
			if (!member || !verified) fail("unauthorized", "Invalid credentials");
			await tx
				.insert(tables.authSessions)
				.values({ ...token, memberId: member.id });
			const { passwordHash: _passwordHash, ...identity } = member;
			return identity;
		});
	}

	/** Local operator boundary: possession of the explicit database connection is authority, not a member session. */
	async recoverAdminPassword(address: string, password: string): Promise<void> {
		const parsedEmail = z
			.string()
			.trim()
			.toLowerCase()
			.pipe(z.email().max(254))
			.safeParse(address);
		if (!parsedEmail.success)
			fail("invalid_input", "Provide a valid administrator email");
		if (!passwordSchema.safeParse(password).success)
			fail("invalid_input", "Password must contain 12–256 characters");
		const passwordHash = await hashPassword(password);
		return this.transaction(async (tx) => {
			// The company fence also serializes login, so an old-password login cannot escape revocation.
			const [company] = await tx
				.select({ id: tables.company.id })
				.from(tables.company)
				.where(eq(tables.company.id, 1))
				.for("update");
			if (!company)
				fail(
					"conflict",
					"Vault is not initialized; recovery cannot bootstrap it",
				);
			const [member] = await tx
				.select({
					id: tables.members.id,
					role: tables.members.role,
					disabled: tables.members.disabled,
				})
				.from(tables.members)
				.where(eq(tables.members.email, parsedEmail.data));
			if (!member) fail("not_found", "Administrator not found");
			if (member.role !== "admin")
				fail("forbidden", "Recovery requires an existing administrator");
			if (member.disabled)
				fail(
					"forbidden",
					"Disabled administrators cannot be recovered; recovery never re-enables accounts",
				);
			await tx
				.update(tables.members)
				.set({ passwordHash })
				.where(eq(tables.members.id, member.id));
			await tx
				.update(tables.authSessions)
				.set({ revoked: true })
				.where(eq(tables.authSessions.memberId, member.id));
			await this.audit(tx, null, "admin.password_recovered", member.id);
		});
	}

	async me(caller: VaultCaller): Promise<VaultMember> {
		return this.authorized(
			caller,
			false,
			async (_tx, { device: _device, ...member }) => member,
		);
	}

	async deviceIdentity(caller: VaultCaller): Promise<{ id: string }> {
		return this.authorized(caller, false, async (_tx, actor) => {
			if (!actor.device) fail("forbidden", "Device credentials required");
			return { id: actor.device.id };
		});
	}

	async logout(caller: VaultCaller): Promise<void> {
		return this.authorized(caller, true, async (tx, actor) => {
			human(actor);
			await tx
				.update(tables.authSessions)
				.set({ revoked: true })
				.where(eq(tables.authSessions.tokenHash, caller.tokenHash));
		});
	}

	async listMembers(caller: VaultCaller, page: VaultPageRequest = {}) {
		const { limit, after } = pagination(page);
		return this.authorized(caller, false, async (tx, actor) => {
			admin(actor);
			return paged(
				await tx
					.select(memberFields)
					.from(tables.members)
					.where(after ? gt(tables.members.id, after) : undefined)
					.orderBy(asc(tables.members.id))
					.limit(limit + 1),
				limit,
			);
		});
	}

	async updateMember(
		caller: VaultCaller,
		memberId: string,
		change: { role?: VaultRole; disabled?: boolean },
	): Promise<VaultMember> {
		return this.authorized(caller, true, async (tx, actor) => {
			admin(actor);
			const [previous] = await tx
				.select(memberFields)
				.from(tables.members)
				.where(eq(tables.members.id, memberId));
			if (!previous) fail("not_found", "Member not found");
			const role = change.role ?? previous.role;
			const disabled = change.disabled ?? previous.disabled;
			if (
				previous.role === "admin" &&
				!previous.disabled &&
				(disabled || role !== "admin")
			) {
				const others = await tx
					.select({ id: tables.members.id })
					.from(tables.members)
					.where(
						and(
							eq(tables.members.role, "admin"),
							eq(tables.members.disabled, false),
							sql`${tables.members.id} <> ${memberId}`,
						),
					)
					.limit(1);
				if (!others.length)
					fail(
						"conflict",
						"Cannot disable or demote the last active administrator",
					);
			}
			const [updated] = await tx
				.update(tables.members)
				.set({ role, disabled })
				.where(eq(tables.members.id, memberId))
				.returning(memberFields);
			if (!updated) fail("not_found", "Member not found");
			if (disabled) {
				await tx
					.update(tables.authSessions)
					.set({ revoked: true })
					.where(eq(tables.authSessions.memberId, memberId));
				await tx
					.update(tables.devices)
					.set({ revoked: true })
					.where(eq(tables.devices.memberId, memberId));
			}
			await this.audit(tx, actor.id, "member.updated", memberId);
			return updated;
		});
	}

	async createInvitation(
		caller: VaultCaller,
		proposed: VaultIdentity & { role: VaultRole },
		token: VaultSessionToken,
	) {
		sessionToken(token);
		return this.authorized(caller, true, async (tx, actor) => {
			admin(actor);
			const [duplicate] = await tx
				.select({ id: tables.members.id })
				.from(tables.members)
				.where(eq(tables.members.email, email(proposed.email)));
			if (duplicate)
				fail("conflict", "A member with that email already exists");
			const [invitation] = await tx
				.insert(tables.invitations)
				.values({ ...proposed, email: email(proposed.email), ...token })
				.returning(invitationFields);
			if (!invitation) fail("conflict", "Could not create invitation");
			await this.audit(tx, actor.id, "invitation.created", invitation.id);
			return invitation;
		});
	}

	async listInvitations(caller: VaultCaller, page: VaultPageRequest = {}) {
		const { limit, after } = pagination(page);
		return this.authorized(caller, false, async (tx, actor) => {
			admin(actor);
			return paged(
				await tx
					.select(invitationFields)
					.from(tables.invitations)
					.where(after ? gt(tables.invitations.id, after) : undefined)
					.orderBy(asc(tables.invitations.id))
					.limit(limit + 1),
				limit,
			);
		});
	}

	async revokeInvitation(
		caller: VaultCaller,
		invitationId: string,
	): Promise<void> {
		return this.authorized(caller, true, async (tx, actor) => {
			admin(actor);
			const rows = await tx
				.update(tables.invitations)
				.set({ revoked: true })
				.where(eq(tables.invitations.id, invitationId))
				.returning({ id: tables.invitations.id });
			if (!rows.length) fail("not_found", "Invitation not found");
			await this.audit(tx, actor.id, "invitation.revoked", invitationId);
		});
	}

	async redeemInvitation(
		invitationHash: string,
		passwordHash: string,
		token: VaultSessionToken,
	): Promise<VaultMember> {
		hash(invitationHash);
		sessionToken(token);
		return this.transaction(async (tx) => {
			await tx
				.select({ id: tables.company.id })
				.from(tables.company)
				.for("update");
			const [invitation] = await tx
				.update(tables.invitations)
				.set({ redeemedAt: sql`now()` })
				.where(
					and(
						eq(tables.invitations.tokenHash, invitationHash),
						eq(tables.invitations.revoked, false),
						isNull(tables.invitations.redeemedAt),
						gt(tables.invitations.expiresAt, sql`clock_timestamp()`),
					),
				)
				.returning();
			if (!invitation) fail("unauthorized", "Invitation is invalid or expired");
			const [member] = await tx
				.insert(tables.members)
				.values({
					email: invitation.email,
					name: invitation.name,
					role: invitation.role,
					passwordHash,
				})
				.returning(memberFields);
			if (!member) fail("conflict", "Could not create member");
			await tx
				.insert(tables.authSessions)
				.values({ ...token, memberId: member.id });
			await this.audit(tx, member.id, "invitation.redeemed", invitation.id);
			return member;
		});
	}

	async enrollDevice(
		caller: VaultCaller,
		input: { source: VaultSource; name: string; tokenHash: string },
	) {
		hash(input.tokenHash);
		return this.authorized(caller, true, async (tx, actor) => {
			human(actor);
			const [device] = await tx
				.insert(tables.devices)
				.values({ ...input, memberId: actor.id })
				.returning(deviceFields);
			if (!device) fail("conflict", "Could not enroll device");
			await this.audit(tx, actor.id, "device.enrolled", device.id);
			return device;
		});
	}

	async listDevices(caller: VaultCaller, page: VaultPageRequest = {}) {
		const { limit, after } = pagination(page);
		return this.authorized(caller, false, async (tx, actor) => {
			human(actor);
			return paged(
				await tx
					.select(deviceFields)
					.from(tables.devices)
					.where(
						and(
							actor.role === "admin"
								? undefined
								: eq(tables.devices.memberId, actor.id),
							after ? gt(tables.devices.id, after) : undefined,
						),
					)
					.orderBy(asc(tables.devices.id))
					.limit(limit + 1),
				limit,
			);
		});
	}

	async revokeDevice(caller: VaultCaller, deviceId: string): Promise<void> {
		return this.authorized(caller, true, async (tx, actor) => {
			human(actor);
			const [device] = await tx
				.select({ memberId: tables.devices.memberId })
				.from(tables.devices)
				.where(eq(tables.devices.id, deviceId));
			if (!device) fail("not_found", "Device not found");
			own(actor, device.memberId);
			await tx
				.update(tables.devices)
				.set({ revoked: true })
				.where(eq(tables.devices.id, deviceId));
			await this.audit(tx, actor.id, "device.revoked", deviceId);
		});
	}

	private async policy(
		tx: Transaction,
		memberId: string,
		company: typeof tables.company.$inferSelect,
	): Promise<VaultPolicy> {
		const [member] = await tx
			.select({
				accounts: tables.members.accounts,
				locations: tables.members.locations,
			})
			.from(tables.members)
			.where(eq(tables.members.id, memberId));
		if (!member) fail("not_found", "Member not found");
		return {
			repositories: company.repositories,
			revision: company.revision,
			...member,
		};
	}

	async getPolicy(caller: VaultCaller): Promise<VaultPolicy> {
		return this.authorized(caller, false, (tx, actor, company) =>
			this.policy(tx, actor.id, company),
		);
	}

	async updateOwnPolicy(
		caller: VaultCaller,
		policy: { accounts: VaultAccount[]; locations: string[] },
	): Promise<VaultPolicy> {
		return this.authorized(caller, true, async (tx, actor) => {
			human(actor);
			await tx
				.update(tables.members)
				.set(policy)
				.where(eq(tables.members.id, actor.id));
			const [company] = await tx
				.update(tables.company)
				.set({ revision: sql`${tables.company.revision} + 1` })
				.where(eq(tables.company.id, 1))
				.returning();
			if (!company) fail("not_found", "Company not found");
			await this.audit(tx, actor.id, "policy.member_updated", actor.id);
			return this.policy(tx, actor.id, company);
		});
	}

	async updateRepositories(
		caller: VaultCaller,
		repositories: string[],
	): Promise<VaultPolicy> {
		return this.authorized(caller, true, async (tx, actor) => {
			admin(actor);
			const [company] = await tx
				.update(tables.company)
				.set({ repositories, revision: sql`${tables.company.revision} + 1` })
				.where(eq(tables.company.id, 1))
				.returning();
			if (!company) fail("not_found", "Company not found");
			await this.audit(tx, actor.id, "policy.repositories_updated", "1");
			return this.policy(tx, actor.id, company);
		});
	}

	async ingest(
		caller: VaultCaller,
		expectedPolicyRevision: number,
		events: readonly TraceEvent[],
	): Promise<VaultIngestResult> {
		if (events.length > 1000)
			fail("invalid_input", "Ingest batch exceeds 1000 events");
		return this.authorized(caller, true, async (tx, actor, company) => {
			if (!actor.device) fail("forbidden", "Device credentials required");
			if (company.revision !== expectedPolicyRevision)
				fail("policy_changed", "Capture policy changed; fetch it again");
			const policy = await this.policy(tx, actor.id, company);
			if (
				events.some(
					(event) =>
						!event.capture || !permitsVaultCapture(policy, event.capture),
				)
			) {
				fail(
					"forbidden",
					"Every event must carry current eligible capture authorization",
				);
			}
			const acceptedEventIds = [
				...new Set(events.map((event) => event.eventId)),
			];
			if (!events.length) return { acceptedEventIds, insertedCount: 0 };
			const source = actor.device.source;
			const context = await storageContext(tx, actor.id, source);
			const deletedEvents = await tx
				.select({ id: tables.eventTombstones.eventId })
				.from(tables.eventTombstones)
				.where(
					and(
						eq(tables.eventTombstones.memberId, actor.id),
						eq(tables.eventTombstones.source, source),
						inArray(tables.eventTombstones.eventId, acceptedEventIds),
					),
				);
			const deletedEventIds = new Set(deletedEvents.map((row) => row.id));
			const eligible = prepareTraceIngestRows({ events }).events.filter(
				(event) => !deletedEventIds.has(event.eventId),
			);
			if (!eligible.length) return { acceptedEventIds, insertedCount: 0 };
			const changes = await ingestTraceBatch(
				tx,
				storageSchema,
				context,
				storageBatch(eligible),
			);
			const changedIds = new Set(
				changes.changedEvents.map((event) => event.eventId),
			);
			await saveTraceReceipts(
				tx,
				context,
				actor.device.id,
				expectedPolicyRevision,
				eligible.filter((event) => changedIds.has(event.eventId)),
			);
			return {
				acceptedEventIds,
				insertedCount: changes.changedEvents.filter((event) => event.inserted)
					.length,
			};
		});
	}

	async listSessions(caller: VaultCaller, page: VaultPageRequest = {}) {
		const { limit } = pagination(page, true);
		const after = cursor(page.after, sessionCursorSchema);
		return this.authorized(caller, false, async (tx, actor) => {
			human(actor);
			const rows = await tx
				.select({
					...sessionFields,
					cursorAt: sql<string>`to_char(${tables.traceSessions.lastReceivedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
				})
				.from(tables.sessionIdentifiers)
				.innerJoin(tables.traceSessions, sessionJoin)
				.innerJoin(
					tables.members,
					eq(tables.members.id, tables.sessionIdentifiers.memberId),
				)
				.where(
					and(
						actor.role === "admin"
							? undefined
							: eq(tables.sessionIdentifiers.memberId, actor.id),
						after
							? sql`(${tables.traceSessions.lastReceivedAt}, ${tables.sessionIdentifiers.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
							: undefined,
					),
				)
				.orderBy(
					desc(tables.traceSessions.lastReceivedAt),
					desc(tables.sessionIdentifiers.id),
				)
				.limit(limit + 1);
			const items = rows
				.slice(0, limit)
				.map(({ cursorAt: _cursorAt, ...row }) => row);
			const last = rows[Math.min(rows.length, limit) - 1];
			return {
				items,
				nextCursor:
					rows.length > limit && last
						? encodeCursor({
								at: last.cursorAt,
								id: last.id,
							})
						: null,
			};
		});
	}

	async getSession(caller: VaultCaller, identity: VaultSessionIdentity) {
		return this.authorized(caller, false, async (tx, actor) => {
			human(actor);
			own(actor, identity.memberId);
			const [session] = await tx
				.select(sessionFields)
				.from(tables.sessionIdentifiers)
				.innerJoin(tables.traceSessions, sessionJoin)
				.innerJoin(
					tables.members,
					eq(tables.members.id, tables.sessionIdentifiers.memberId),
				)
				.where(sessionScope(identity));
			if (!session) fail("not_found", "Session not found");
			return session;
		});
	}

	async getSessionById(caller: VaultCaller, sessionId: string) {
		return this.authorized(caller, false, async (tx, actor) => {
			human(actor);
			const [session] = await tx
				.select(sessionFields)
				.from(tables.sessionIdentifiers)
				.innerJoin(tables.traceSessions, sessionJoin)
				.innerJoin(
					tables.members,
					eq(tables.members.id, tables.sessionIdentifiers.memberId),
				)
				.where(
					and(
						eq(tables.sessionIdentifiers.id, sessionId),
						actor.role === "admin"
							? undefined
							: eq(tables.sessionIdentifiers.memberId, actor.id),
					),
				);
			if (!session) fail("not_found", "Session not found");
			return session;
		});
	}

	async readEvents(
		caller: VaultCaller,
		identity: VaultSessionIdentity | null,
		page: VaultPageRequest = {},
	) {
		const { limit } = pagination(page, true);
		const after = cursor(page.after, eventCursorSchema);
		return this.authorized(caller, false, async (tx, actor) => {
			human(actor);
			if (identity) own(actor, identity.memberId);
			const rows = await tx
				.select(eventFields)
				.from(tables.eventReceipts)
				.innerJoin(tables.traceEvents, receiptJoin)
				.where(
					and(
						identity
							? eventScope(identity)
							: actor.role === "admin"
								? undefined
								: eq(tables.eventReceipts.memberId, actor.id),
						after
							? sql`(${tables.traceEvents.sequence}, ${tables.traceEvents.eventId}, ${tables.eventReceipts.id}) > (${after.sequence}, ${after.eventId}, ${after.id}::uuid)`
							: undefined,
					),
				)
				.orderBy(
					asc(tables.traceEvents.sequence),
					asc(tables.traceEvents.eventId),
					asc(tables.eventReceipts.id),
				)
				.limit(limit + 1);
			const items = rows.slice(0, limit);
			const last = items.at(-1);
			return {
				items,
				nextCursor:
					rows.length > limit && last
						? encodeCursor({
								sequence: last.sequence,
								eventId: last.eventId,
								id: last.id,
							})
						: null,
			};
		});
	}

	async deleteSession(
		caller: VaultCaller,
		identity: VaultSessionIdentity,
	): Promise<void> {
		return this.authorized(caller, true, async (tx, actor) => {
			human(actor);
			own(actor, identity.memberId);
			const context = await storageContext(
				tx,
				identity.memberId,
				identity.source,
			);
			await deleteTraceSession(
				tx,
				storageSchema,
				context,
				identity.sourceSessionId,
				async (transaction) => {
					await transaction
						.insert(tables.eventTombstones)
						.select(
							transaction
								.select({
									memberId: tables.eventReceipts.memberId,
									source: tables.eventReceipts.source,
									eventId: tables.eventReceipts.eventId,
									createdAt: sql<Date>`now()`.as("created_at"),
								})
								.from(tables.eventReceipts)
								.innerJoin(tables.traceEvents, receiptJoin)
								.where(eventScope(identity)),
						)
						.onConflictDoNothing();
					await transaction
						.delete(tables.sessionIdentifiers)
						.where(sessionScope(identity));
				},
				{ tombstoneMissing: true },
			);
			await this.audit(
				tx,
				actor.id,
				"session.deleted",
				JSON.stringify(identity),
			);
		});
	}

	async listAudit(caller: VaultCaller, page: VaultPageRequest = {}) {
		const { limit, after } = pagination(page);
		return this.authorized(caller, false, async (tx, actor) => {
			admin(actor);
			return paged(
				await tx
					.select()
					.from(tables.auditEntries)
					.where(after ? gt(tables.auditEntries.id, after) : undefined)
					.orderBy(asc(tables.auditEntries.id))
					.limit(limit + 1),
				limit,
			);
		});
	}
}
