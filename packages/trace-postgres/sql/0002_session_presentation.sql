CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_compact_text(value text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
    SELECT nullif(btrim(regexp_replace(value,
        U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g')), '')
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_message_preview(p jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
    SELECT left(coalesce(
        CASE WHEN jsonb_typeof(p->'text') = 'string'
            THEN __TRACE_SCHEMA__.trace_compact_text(p->>'text') END,
        CASE WHEN jsonb_typeof(p->'message') = 'string'
            THEN __TRACE_SCHEMA__.trace_compact_text(p->>'message') END,
        (SELECT __TRACE_SCHEMA__.trace_compact_text(string_agg(part->>'text', ' ' ORDER BY position))
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'content') = 'array'
                THEN p->'content' ELSE '[]'::jsonb END) WITH ORDINALITY AS content(part, position)
            WHERE part->>'type' IN ('text', 'input_text') AND jsonb_typeof(part->'text') = 'string')
    ), 160)
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_session_presentation(
    organization_id uuid, device_id uuid, session_id text
) RETURNS TABLE (source_title text, first_user_message_preview text, source_cwd text, source_repository_url text)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
    SELECT
        (SELECT __TRACE_SCHEMA__.trace_compact_text(e.payload->>'title')
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND jsonb_typeof(e.payload->'title') = 'string'
                AND __TRACE_SCHEMA__.trace_compact_text(e.payload->>'title') IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1),
        (SELECT __TRACE_SCHEMA__.trace_message_preview(e.payload)
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'user_message'
                AND __TRACE_SCHEMA__.trace_message_preview(e.payload) IS NOT NULL
            ORDER BY e.sequence, e.event_id COLLATE "C" LIMIT 1),
        (SELECT btrim(e.payload->>'cwd')
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND jsonb_typeof(e.payload->'cwd') = 'string'
                AND __TRACE_SCHEMA__.trace_compact_text(e.payload->>'cwd') IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1),
        (SELECT btrim(e.payload#>>'{git,repository_url}')
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND jsonb_typeof(e.payload#>'{git,repository_url}') = 'string'
                AND __TRACE_SCHEMA__.trace_compact_text(e.payload#>>'{git,repository_url}') IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1)
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.refresh_trace_session_presentation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    UPDATE __TRACE_SCHEMA__.trace_sessions AS session
    SET source_title = projection.source_title,
        source_cwd = projection.source_cwd,
        source_repository_url = projection.source_repository_url,
        first_user_message_preview = projection.first_user_message_preview
    FROM (SELECT DISTINCT organization_id, device_id, session_id FROM inserted_events
        WHERE event_type IN ('session_meta', 'user_message')) AS changed
    CROSS JOIN LATERAL __TRACE_SCHEMA__.trace_session_presentation(
        changed.organization_id, changed.device_id, changed.session_id) AS projection
    WHERE session.organization_id = changed.organization_id
        AND session.device_id = changed.device_id AND session.session_id = changed.session_id;
    RETURN NULL;
END
$function$;

-- PostgreSQL runs same-kind triggers alphabetically; the session must exist first.
DROP TRIGGER IF EXISTS trace_events_update_presentation ON __TRACE_SCHEMA__.trace_events;
CREATE TRIGGER trace_events_update_presentation AFTER INSERT ON __TRACE_SCHEMA__.trace_events
REFERENCING NEW TABLE AS inserted_events
FOR EACH STATEMENT EXECUTE FUNCTION __TRACE_SCHEMA__.refresh_trace_session_presentation();
