import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type { VaultCaptureAuthorization } from "iteration-trace-contracts";
import {
	traceEventColumns,
	traceEventConstraints,
	traceSessionColumns,
	traceSessionConstraints,
	traceSessionDeletionColumns,
	traceSessionDeletionConstraints,
} from "iteration-trace-postgres";
import type {
	VaultAccount,
	VaultRole,
	VaultSource,
} from "./store-contracts.js";

export const vaultSchema = pgSchema("vault");
const createdAt = () =>
	timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tokenHash = () => text("token_hash").notNull().unique();
const source = () => text("source").$type<VaultSource>().notNull();

export const company = vaultSchema.table(
	"company",
	{
		id: integer("id").primaryKey().default(1),
		deploymentId: uuid("deployment_id").notNull().defaultRandom().unique(),
		name: text("name").notNull(),
		revision: integer("revision").notNull().default(1),
		repositories: jsonb("repositories").$type<string[]>().notNull().default([]),
		createdAt: createdAt(),
	},
	(t) => [check("one_company", sql`${t.id} = 1`)],
);

export const members = vaultSchema.table(
	"members",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		email: text("email").notNull().unique(),
		name: text("name").notNull(),
		passwordHash: text("password_hash").notNull(),
		role: text("role").$type<VaultRole>().notNull(),
		disabled: boolean("disabled").notNull().default(false),
		accounts: jsonb("accounts").$type<VaultAccount[]>().notNull().default([]),
		locations: jsonb("locations").$type<string[]>().notNull().default([]),
		createdAt: createdAt(),
	},
	(t) => [
		check("member_role", sql`${t.role} in ('admin', 'member')`),
		check("normalized_email", sql`${t.email} = lower(btrim(${t.email}))`),
	],
);

export const authSessions = vaultSchema.table("auth_sessions", {
	id: uuid("id").primaryKey().defaultRandom(),
	memberId: uuid("member_id")
		.notNull()
		.references(() => members.id),
	tokenHash: tokenHash(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	revoked: boolean("revoked").notNull().default(false),
	createdAt: createdAt(),
});

export const invitations = vaultSchema.table(
	"invitations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		email: text("email").notNull(),
		name: text("name").notNull(),
		role: text("role").$type<VaultRole>().notNull(),
		tokenHash: tokenHash(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
		revoked: boolean("revoked").notNull().default(false),
		createdAt: createdAt(),
	},
	(t) => [check("invitation_role", sql`${t.role} in ('admin', 'member')`)],
);

export const devices = vaultSchema.table(
	"devices",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		name: text("name").notNull(),
		tokenHash: tokenHash(),
		revoked: boolean("revoked").notNull().default(false),
		createdAt: createdAt(),
	},
	(t) => [
		check("device_source", sql`${t.source} in ('claude', 'codex', 'cursor')`),
	],
);

export const sourceTenants = vaultSchema.table("source_tenants", {
	source: source().primaryKey(),
	id: uuid("id").notNull().defaultRandom().unique(),
});

export const storageStreams = vaultSchema.table(
	"storage_streams",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => sourceTenants.id),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
	},
	(t) => [
		unique("storage_stream_identity").on(t.memberId, t.source),
		unique("storage_stream_assignment").on(t.organizationId, t.memberId, t.id),
	],
);

export const traceStorageSchema = pgSchema("vault_traces");
export const traceEvents = traceStorageSchema.table(
	"trace_events",
	traceEventColumns(),
	(t) => [
		...traceEventConstraints(t, { concurrently: false }),
		foreignKey({
			columns: [t.organizationId, t.userId, t.deviceId],
			foreignColumns: [
				storageStreams.organizationId,
				storageStreams.memberId,
				storageStreams.id,
			],
		}),
	],
);
export const traceSessions = traceStorageSchema.table(
	"trace_sessions",
	traceSessionColumns(),
	(t) => [
		...traceSessionConstraints(t, { concurrently: false }),
		foreignKey({
			columns: [t.organizationId, t.userId, t.deviceId],
			foreignColumns: [
				storageStreams.organizationId,
				storageStreams.memberId,
				storageStreams.id,
			],
		}),
	],
);
export const traceSessionDeletions = traceStorageSchema.table(
	"trace_session_deletions",
	traceSessionDeletionColumns(),
	traceSessionDeletionConstraints,
);

export const sessionIdentifiers = vaultSchema.table(
	"session_identifiers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		sourceSessionId: text("source_session_id").notNull(),
		storageStreamId: uuid("storage_stream_id")
			.notNull()
			.references(() => storageStreams.id),
		projectId: text("project_id"),
		title: text("title"),
		createdAt: createdAt(),
	},
	(t) => [
		unique("public_session_identity").on(
			t.memberId,
			t.source,
			t.sourceSessionId,
		),
	],
);

export const eventReceipts = vaultSchema.table(
	"event_receipts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		eventId: text("event_id").notNull(),
		storageStreamId: uuid("storage_stream_id")
			.notNull()
			.references(() => storageStreams.id),
		projectId: text("project_id"),
		occurredAt: text("occurred_at"),
		deviceId: uuid("device_id")
			.notNull()
			.references(() => devices.id),
		captureAuthorization: jsonb("capture_authorization")
			.$type<VaultCaptureAuthorization>()
			.notNull(),
		policyRevision: integer("policy_revision").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		unique("public_event_identity").on(t.memberId, t.source, t.eventId),
		foreignKey({
			columns: [t.storageStreamId, t.eventId],
			foreignColumns: [traceEvents.deviceId, traceEvents.eventId],
		}).onDelete("cascade"),
	],
);

export const eventTombstones = vaultSchema.table(
	"event_tombstones",
	{
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		eventId: text("event_id").notNull(),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.memberId, t.source, t.eventId] })],
);

export const storageUpgrade = vaultSchema.table(
	"storage_upgrade",
	{
		id: integer("id").primaryKey().default(1),
		lastEventId: uuid("last_event_id"),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(t) => [check("one_storage_upgrade", sql`${t.id} = 1`)],
);

export const auditEntries = vaultSchema.table("audit_entries", {
	id: uuid("id").primaryKey().defaultRandom(),
	actorId: uuid("actor_id").references(() => members.id),
	action: text("action").notNull(),
	targetId: text("target_id").notNull(),
	createdAt: createdAt(),
});
