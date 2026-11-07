ALTER TABLE "vault_traces"."trace_events" DROP CONSTRAINT "trace_events_payload_object";--> statement-breakpoint
DROP INDEX "vault_traces"."trace_events_turn_context";--> statement-breakpoint
DROP INDEX "vault_traces"."trace_events_usage_without_model";--> statement-breakpoint
DROP INDEX "vault_traces"."trace_events_claude_agent_result";--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "payload_object" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "payload_offset" bigint;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "payload_length" integer;--> statement-breakpoint
CREATE INDEX "trace_events_turn_context" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","turn_id") WHERE "vault_traces"."trace_events"."event_type" = 'turn_context';--> statement-breakpoint
CREATE INDEX "trace_events_usage_without_model" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","turn_id") WHERE "vault_traces"."trace_events"."usage_at" IS NOT NULL AND "vault_traces"."trace_events"."model" IS NULL;--> statement-breakpoint
CREATE INDEX "trace_events_claude_agent_result" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","tool_result_agent_id") WHERE "vault_traces"."trace_events"."event_type" = 'tool_result' AND "vault_traces"."trace_events"."tool_result_agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD CONSTRAINT "trace_events_payload_stored" CHECK ("vault_traces"."trace_events"."payload" IS NOT NULL OR ("vault_traces"."trace_events"."payload_object" IS NOT NULL AND "vault_traces"."trace_events"."payload_offset" >= 0 AND "vault_traces"."trace_events"."payload_length" > 0));--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD CONSTRAINT "trace_events_payload_object_length" CHECK ("vault_traces"."trace_events"."payload_object" IS NULL OR char_length("vault_traces"."trace_events"."payload_object") BETWEEN 1 AND 1024);--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD CONSTRAINT "trace_events_payload_object" CHECK ("vault_traces"."trace_events"."payload" IS NULL OR jsonb_typeof("vault_traces"."trace_events"."payload") = 'object');