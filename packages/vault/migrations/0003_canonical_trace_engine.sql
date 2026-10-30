CREATE SCHEMA "vault_traces";
--> statement-breakpoint
CREATE TABLE "vault"."event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"storage_stream_id" uuid NOT NULL,
	"project_id" text,
	"occurred_at" text,
	"device_id" uuid NOT NULL,
	"capture_authorization" jsonb NOT NULL,
	"policy_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_event_identity" UNIQUE("member_id","source","event_id")
);
--> statement-breakpoint
CREATE TABLE "vault"."session_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_session_id" text NOT NULL,
	"storage_stream_id" uuid NOT NULL,
	"project_id" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_session_identity" UNIQUE("member_id","source","source_session_id")
);
--> statement-breakpoint
CREATE TABLE "vault"."source_tenants" (
	"source" text PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "source_tenants_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "vault"."storage_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "storage_stream_identity" UNIQUE("member_id","source"),
	CONSTRAINT "storage_stream_assignment" UNIQUE("organization_id","member_id","id")
);
--> statement-breakpoint
CREATE TABLE "vault"."storage_upgrade" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_event_id" uuid,
	"completed_at" timestamp with time zone,
	CONSTRAINT "one_storage_upgrade" CHECK ("vault"."storage_upgrade"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "vault_traces"."trace_events" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"session_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"call_id" text,
	"occurred_at" timestamp with time zone,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run" jsonb,
	"display_text" text,
	"is_instruction" boolean DEFAULT false NOT NULL,
	"tool_name" text,
	"exit_code" integer,
	"model" text,
	"context_window" bigint,
	"total_tokens" bigint,
	"usage_at" timestamp with time zone,
	"usage_input_tokens" bigint,
	"usage_cache_read_tokens" bigint,
	"usage_cache_write_tokens" bigint,
	"usage_cache_write_long_tokens" bigint,
	"usage_output_tokens" bigint,
	"billing_kind" text,
	"billing_paid_usd" numeric(12, 6),
	"pull_request_url" text,
	"tool_activity" text,
	"tool_failed" boolean,
	"usage_activity" text,
	"usage_after_error" boolean,
	"thread_id" text,
	"parent_thread_id" text,
	"is_run_start" boolean DEFAULT false NOT NULL,
	"run_start_ordinal" bigint,
	"agent_path" text,
	"agent_nickname" text,
	"launch_cwd" text,
	"launch_branch" text,
	"launch_repository_url" text,
	"launch_commit_hash" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_events_pkey" PRIMARY KEY("device_id","event_id"),
	CONSTRAINT "trace_events_sequence_nonnegative" CHECK ("vault_traces"."trace_events"."sequence" >= 0),
	CONSTRAINT "trace_events_event_id_length" CHECK (char_length("vault_traces"."trace_events"."event_id") BETWEEN 1 AND 200),
	CONSTRAINT "trace_events_session_id_length" CHECK (char_length("vault_traces"."trace_events"."session_id") BETWEEN 1 AND 200),
	CONSTRAINT "trace_events_call_id_length" CHECK ("vault_traces"."trace_events"."call_id" IS NULL OR char_length("vault_traces"."trace_events"."call_id") <= 255),
	CONSTRAINT "trace_events_payload_object" CHECK (jsonb_typeof("vault_traces"."trace_events"."payload") = 'object'),
	CONSTRAINT "trace_events_type" CHECK ("vault_traces"."trace_events"."event_type" IN ('user_message', 'assistant_message', 'tool_call', 'tool_result', 'session_meta', 'task_started', 'turn_context', 'compacted', 'token_usage_record', 'token_count', 'world_state', 'retained_context', 'security_risk_score', 'reasoning', 'agent_reasoning', 'agent_reasoning_raw_content', 'todo_list', 'compaction', 'context_compaction', 'configuration_update', 'additional_tools', 'task_complete', 'turn_complete', 'thread_goal_updated', 'thread_rolled_back', 'turn_aborted', 'thread_settings_applied', 'source_record')),
	CONSTRAINT "trace_events_tool_activity" CHECK ("vault_traces"."trace_events"."tool_activity" IN ('exploring', 'running', 'editing', 'delegating')),
	CONSTRAINT "trace_events_usage_activity" CHECK ("vault_traces"."trace_events"."usage_activity" IN ('exploring', 'running', 'editing', 'delegating', 'answering')),
	CONSTRAINT "trace_events_billing_kind" CHECK ("vault_traces"."trace_events"."billing_kind" IN ('included', 'paid', 'byok', 'not_charged', 'mixed')),
	CONSTRAINT "trace_events_billing_paid_usd" CHECK ("vault_traces"."trace_events"."billing_paid_usd" IS NULL OR ("vault_traces"."trace_events"."billing_paid_usd" >= 0 AND "vault_traces"."trace_events"."billing_kind" IN ('paid', 'mixed')))
);
--> statement-breakpoint
CREATE TABLE "vault_traces"."trace_session_deletions" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_session_deletions_pkey" PRIMARY KEY("organization_id","user_id","session_id"),
	CONSTRAINT "trace_session_deletions_session_id_length" CHECK (char_length("vault_traces"."trace_session_deletions"."session_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "vault_traces"."trace_sessions" (
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"event_count" bigint NOT NULL,
	"thread_id" text,
	"parent_thread_id" text,
	"codex_billing_status" text,
	"codex_billing_source" text,
	"codex_billing_credits" numeric,
	"codex_billing_account" text,
	"codex_billing_checked_at" timestamp with time zone,
	"own_start_sequence" bigint,
	"own_event_count" bigint DEFAULT 0 NOT NULL,
	"agent_path" text,
	"agent_nickname" text,
	"agent_description" text,
	"user_message_preview" text,
	"source_title" text,
	"source_cwd" text,
	"source_repository_url" text,
	"first_user_message_preview" text,
	"launch_cwd" text,
	"launch_branch" text,
	"launch_repository_url" text,
	"launch_commit_hash" text,
	"first_occurred_at" timestamp with time zone,
	"last_occurred_at" timestamp with time zone,
	"first_received_at" timestamp with time zone NOT NULL,
	"last_received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trace_sessions_pkey" PRIMARY KEY("organization_id","device_id","session_id"),
	CONSTRAINT "trace_sessions_event_count_positive" CHECK ("vault_traces"."trace_sessions"."event_count" > 0),
	CONSTRAINT "trace_sessions_codex_billing_status" CHECK ("vault_traces"."trace_sessions"."codex_billing_status" IN ('available', 'partial', 'unavailable')),
	CONSTRAINT "trace_sessions_codex_billing_credits" CHECK ("vault_traces"."trace_sessions"."codex_billing_credits" IS NULL OR "vault_traces"."trace_sessions"."codex_billing_status" = 'available'),
	CONSTRAINT "trace_sessions_session_id_length" CHECK (char_length("vault_traces"."trace_sessions"."session_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "vault"."session_tombstones" RENAME TO "legacy_session_tombstones";--> statement-breakpoint
ALTER TABLE "vault"."trace_events" RENAME TO "legacy_trace_events";--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" RENAME TO "legacy_trace_sessions";--> statement-breakpoint
ALTER TABLE "vault"."event_receipts" ADD CONSTRAINT "event_receipts_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."event_receipts" ADD CONSTRAINT "event_receipts_storage_stream_id_storage_streams_id_fk" FOREIGN KEY ("storage_stream_id") REFERENCES "vault"."storage_streams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."event_receipts" ADD CONSTRAINT "event_receipts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "vault"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."event_receipts" ADD CONSTRAINT "event_receipts_storage_stream_id_event_id_trace_events_device_id_event_id_fk" FOREIGN KEY ("storage_stream_id","event_id") REFERENCES "vault_traces"."trace_events"("device_id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."session_identifiers" ADD CONSTRAINT "session_identifiers_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."session_identifiers" ADD CONSTRAINT "session_identifiers_storage_stream_id_storage_streams_id_fk" FOREIGN KEY ("storage_stream_id") REFERENCES "vault"."storage_streams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."storage_streams" ADD CONSTRAINT "storage_streams_organization_id_source_tenants_id_fk" FOREIGN KEY ("organization_id") REFERENCES "vault"."source_tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault"."storage_streams" ADD CONSTRAINT "storage_streams_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "vault"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD CONSTRAINT "trace_events_organization_id_user_id_device_id_storage_streams_organization_id_member_id_id_fk" FOREIGN KEY ("organization_id","user_id","device_id") REFERENCES "vault"."storage_streams"("organization_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_sessions" ADD CONSTRAINT "trace_sessions_organization_id_user_id_device_id_storage_streams_organization_id_member_id_id_fk" FOREIGN KEY ("organization_id","user_id","device_id") REFERENCES "vault"."storage_streams"("organization_id","member_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_events_session_order" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","sequence");--> statement-breakpoint
CREATE INDEX "trace_events_session_metadata" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","sequence","event_id") WHERE "vault_traces"."trace_events"."event_type" = 'session_meta' OR "vault_traces"."trace_events"."thread_id" IS NOT NULL OR "vault_traces"."trace_events"."is_run_start";--> statement-breakpoint
CREATE INDEX "trace_events_message_occurred" ON "vault_traces"."trace_events" USING btree ("organization_id","event_type","occurred_at") WHERE "vault_traces"."trace_events"."occurred_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_message_received" ON "vault_traces"."trace_events" USING btree ("organization_id","event_type","ingested_at") WHERE "vault_traces"."trace_events"."ingested_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_user_message_order" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","sequence","event_id") WHERE "vault_traces"."trace_events"."event_type" = 'user_message';--> statement-breakpoint
CREATE INDEX "trace_events_organization_received" ON "vault_traces"."trace_events" USING btree ("organization_id","ingested_at");--> statement-breakpoint
CREATE INDEX "trace_events_user_session" ON "vault_traces"."trace_events" USING btree ("organization_id","user_id","session_id");--> statement-breakpoint
CREATE INDEX "trace_events_usage_time" ON "vault_traces"."trace_events" USING btree ("organization_id","usage_at") WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_usage_workspace" ON "vault_traces"."trace_events" USING btree ("organization_id","usage_at","device_id","session_id","user_id","model","usage_input_tokens","usage_cache_read_tokens","usage_cache_write_tokens","usage_cache_write_long_tokens","usage_output_tokens","usage_activity","usage_after_error","billing_kind","billing_paid_usd") WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_usage_cost" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","usage_at","model","usage_input_tokens","usage_cache_read_tokens","usage_cache_write_tokens","usage_cache_write_long_tokens","usage_output_tokens") WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_usage_session" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","usage_at") WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_turn_context" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id",("payload"->>'turn_id')) WHERE "vault_traces"."trace_events"."event_type" = 'turn_context';--> statement-breakpoint
CREATE INDEX "trace_events_usage_order" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","sequence") WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_usage_without_model" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id",("payload"->>'turn_id')) WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL AND "vault_traces"."trace_events"."model" IS NULL;--> statement-breakpoint
CREATE INDEX "trace_events_pull_request" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id") WHERE "vault_traces"."trace_events"."pull_request_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_claude_agent_result" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id",("payload"#>>'{record,toolUseResult,agentId}')) WHERE "vault_traces"."trace_events"."event_type" = 'tool_result' AND ("vault_traces"."trace_events"."payload"#>>'{record,toolUseResult,agentId}') IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_sessions_occurred_time" ON "vault_traces"."trace_sessions" USING btree ("organization_id","last_occurred_at") WHERE "vault_traces"."trace_sessions"."last_occurred_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_sessions_recent" ON "vault_traces"."trace_sessions" USING btree ("organization_id","last_received_at" DESC NULLS LAST,"device_id","session_id");--> statement-breakpoint
CREATE INDEX "trace_sessions_user_recent" ON "vault_traces"."trace_sessions" USING btree ("organization_id","user_id","last_received_at" DESC NULLS LAST,"device_id","session_id");--> statement-breakpoint
CREATE INDEX "trace_sessions_first_received" ON "vault_traces"."trace_sessions" USING btree ("organization_id","first_received_at");--> statement-breakpoint
CREATE INDEX "trace_sessions_user_session" ON "vault_traces"."trace_sessions" USING btree ("organization_id","user_id","session_id");--> statement-breakpoint
CREATE INDEX "trace_sessions_thread" ON "vault_traces"."trace_sessions" USING btree ("organization_id","user_id","device_id","thread_id");--> statement-breakpoint
CREATE INDEX "trace_sessions_parent_thread" ON "vault_traces"."trace_sessions" USING btree ("organization_id","user_id","device_id","parent_thread_id");--> statement-breakpoint
CREATE VIEW "vault_traces"."collector_devices" AS
SELECT id, organization_id, member_id AS user_id, source FROM "vault"."storage_streams";--> statement-breakpoint
INSERT INTO "vault"."storage_upgrade" (id) VALUES (1);
