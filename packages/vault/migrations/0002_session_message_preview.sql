ALTER TABLE "vault"."trace_sessions" ADD COLUMN "first_user_message" text;--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" ADD COLUMN "first_user_message_sequence" integer;--> statement-breakpoint
ALTER TABLE "vault"."trace_sessions" ADD COLUMN "first_user_message_event_id" text;--> statement-breakpoint
WITH whitespace AS (
	SELECT U&'[\0009-\000d\0020\00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+' AS pattern
), messages AS (
	SELECT member_id, source, source_session_id, sequence, event_id,
		coalesce(
			CASE WHEN jsonb_typeof(payload->'payload'->'text') = 'string'
				THEN nullif(btrim(regexp_replace(payload->'payload'->>'text', pattern, ' ', 'g')), '') END,
			CASE WHEN jsonb_typeof(payload->'payload'->'message') = 'string'
				THEN nullif(btrim(regexp_replace(payload->'payload'->>'message', pattern, ' ', 'g')), '') END,
			btrim(regexp_replace((SELECT string_agg(block->>'text', ' ' ORDER BY ordinal)
				FROM jsonb_array_elements(CASE
					WHEN jsonb_typeof(payload->'payload'->'content') = 'array'
					THEN payload->'payload'->'content' ELSE '[]'::jsonb END)
					WITH ORDINALITY AS blocks(block, ordinal)
				WHERE block->>'type' IN ('text', 'input_text')
					AND jsonb_typeof(block->'text') = 'string'), pattern, ' ', 'g'))
		) AS preview
	FROM "vault"."trace_events" CROSS JOIN whitespace
	WHERE payload->>'eventType' = 'user_message'
), first_messages AS (
	SELECT DISTINCT ON (member_id, source, source_session_id)
		member_id, source, source_session_id, sequence, event_id, left(preview, 160) AS preview
	FROM messages
	WHERE preview <> ''
	ORDER BY member_id, source, source_session_id, sequence, event_id COLLATE "C"
)
UPDATE "vault"."trace_sessions" AS session
SET first_user_message = message.preview,
	first_user_message_sequence = message.sequence,
	first_user_message_event_id = message.event_id
FROM first_messages AS message
WHERE session.member_id = message.member_id
	AND session.source = message.source
	AND session.source_session_id = message.source_session_id;
