CREATE SCHEMA "vault";
--> statement-breakpoint
CREATE TABLE "vault"."audit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault"."auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "vault"."company" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_company" CHECK ("vault"."company"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "vault"."devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "device_source" CHECK ("vault"."devices"."source" in ('claude', 'codex', 'cursor'))
);
--> statement-breakpoint
CREATE TABLE "vault"."event_tombstones" (
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_tombstones_member_id_source_event_id_pk" PRIMARY KEY("member_id","source","event_id")
);
--> statement-breakpoint
CREATE TABLE "vault"."invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitation_role" CHECK ("vault"."invitations"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "vault"."members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_email_unique" UNIQUE("email"),
	CONSTRAINT "member_role" CHECK ("vault"."members"."role" in ('admin', 'member')),
	CONSTRAINT "normalized_email" CHECK ("vault"."members"."email" = lower(btrim("vault"."members"."email")))
);
--> statement-breakpoint
CREATE TABLE "vault"."session_tombstones" (
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_tombstones_member_id_source_source_session_id_pk" PRIMARY KEY("member_id","source","source_session_id")
);
--> statement-breakpoint
CREATE TABLE "vault"."trace_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"source_session_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"capture_authorization" jsonb NOT NULL,
	"policy_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_event_identity" UNIQUE("member_id","source","event_id")
);
--> statement-breakpoint
CREATE TABLE "vault"."trace_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_session_id" text NOT NULL,
	"project_id" text,
	"cwd" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_session_identity" UNIQUE("member_id","source","source_session_id")
);
--> statement-breakpoint
ALTER TABLE "vault"."audit_entries" ADD CONSTRAINT "audit_entries_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."auth_sessions" ADD CONSTRAINT "auth_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."devices" ADD CONSTRAINT "devices_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."event_tombstones" ADD CONSTRAINT "event_tombstones_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."session_tombstones" ADD CONSTRAINT "session_tombstones_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."trace_events" ADD CONSTRAINT "trace_events_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."trace_events" ADD CONSTRAINT "trace_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "vault"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" ADD CONSTRAINT "trace_sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;