import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	TraceEvent,
	VaultCaptureAuthorization,
} from "iteration-trace-contracts";
import type {
	VaultAccount,
	VaultRole,
	VaultSource,
} from "./store-contracts.js";

const vaultSchema = pgSchema("vault");
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

export const traceSessions = vaultSchema.table(
	"trace_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		sourceSessionId: text("source_session_id").notNull(),
		projectId: text("project_id"),
		cwd: text("cwd"),
		title: text("title"),
		repository: text("repository"),
		eventCount: integer("event_count").notNull().default(0),
		lastReceivedAt: timestamp("last_received_at", {
			withTimezone: true,
			precision: 3,
		})
			.notNull()
			.defaultNow(),
		createdAt: createdAt(),
	},
	(t) => [
		unique("trace_session_identity").on(
			t.memberId,
			t.source,
			t.sourceSessionId,
		),
	],
);

export const traceEvents = vaultSchema.table(
	"trace_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		eventId: text("event_id").notNull(),
		sourceSessionId: text("source_session_id").notNull(),
		sequence: integer("sequence").notNull(),
		occurredAt: text("occurred_at"),
		deviceId: uuid("device_id")
			.notNull()
			.references(() => devices.id),
		payload: jsonb("payload").$type<TraceEvent>().notNull(),
		captureAuthorization: jsonb("capture_authorization")
			.$type<VaultCaptureAuthorization>()
			.notNull(),
		policyRevision: integer("policy_revision").notNull(),
		createdAt: createdAt(),
	},
	(t) => [unique("trace_event_identity").on(t.memberId, t.source, t.eventId)],
);

export const sessionTombstones = vaultSchema.table(
	"session_tombstones",
	{
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id),
		source: source(),
		sourceSessionId: text("source_session_id").notNull(),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.memberId, t.source, t.sourceSessionId] })],
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

export const auditEntries = vaultSchema.table("audit_entries", {
	id: uuid("id").primaryKey().defaultRandom(),
	actorId: uuid("actor_id").references(() => members.id),
	action: text("action").notNull(),
	targetId: text("target_id").notNull(),
	createdAt: createdAt(),
});
