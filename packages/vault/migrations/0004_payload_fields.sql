ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "payload_thread_id" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "record_cwd" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "record_git_branch" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "tool_result_agent_id" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "tool_result_description" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "meta_title" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "meta_cwd" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "meta_repository_url" text;--> statement-breakpoint
ALTER TABLE "vault_traces"."trace_events" ADD COLUMN "message_preview" text;