ALTER TABLE "vault"."company" ADD COLUMN "deployment_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "vault"."trace_events" ADD COLUMN "sequence" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "vault"."trace_events" ADD COLUMN "occurred_at" text;--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" ADD COLUMN "event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" ADD COLUMN "last_received_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "vault"."company" ADD CONSTRAINT "company_deployment_id_unique" UNIQUE("deployment_id");