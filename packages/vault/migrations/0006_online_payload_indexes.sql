DROP INDEX "vault_traces"."trace_events_turn_context";--> statement-breakpoint
DROP INDEX "vault_traces"."trace_events_usage_without_model";--> statement-breakpoint
DROP INDEX "vault_traces"."trace_events_claude_agent_result";--> statement-breakpoint
CREATE INDEX "trace_events_turn" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","turn_id") WHERE "vault_traces"."trace_events"."turn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_agent_result" ON "vault_traces"."trace_events" USING btree ("organization_id","device_id","session_id","tool_result_agent_id") WHERE "vault_traces"."trace_events"."tool_result_agent_id" IS NOT NULL;