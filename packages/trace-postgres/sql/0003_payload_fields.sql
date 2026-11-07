-- Payload fields other rows read, kept as columns so a host can later store
-- payloads outside PostgreSQL. Each column holds the raw value its readers
-- extract today; readers keep their own trimming and limits. The write
-- trigger and host backfills share this one definition.
CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_payload_fields(p jsonb, event_type text)
RETURNS TABLE (
    turn_id text, payload_thread_id text, record_cwd text, record_git_branch text,
    tool_result_agent_id text, tool_result_description text, meta_title text,
    meta_cwd text, meta_repository_url text, message_preview text
) LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
    SELECT p->>'turn_id', p->>'thread_id', p#>>'{record,cwd}', p#>>'{record,gitBranch}',
        p#>>'{record,toolUseResult,agentId}', p#>>'{record,toolUseResult,description}',
        CASE WHEN jsonb_typeof(p->'title') = 'string' THEN p->>'title' END,
        CASE WHEN jsonb_typeof(p->'cwd') = 'string' THEN p->>'cwd' END,
        CASE WHEN jsonb_typeof(p#>'{git,repository_url}') = 'string'
            THEN p#>>'{git,repository_url}' END,
        CASE WHEN event_type = 'user_message'
            THEN __TRACE_SCHEMA__.trace_message_preview(p) END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.project_trace_payload_fields_before_write() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    SELECT f.turn_id, f.payload_thread_id, f.record_cwd, f.record_git_branch,
        f.tool_result_agent_id, f.tool_result_description, f.meta_title,
        f.meta_cwd, f.meta_repository_url, f.message_preview
    INTO NEW.turn_id, NEW.payload_thread_id, NEW.record_cwd, NEW.record_git_branch,
        NEW.tool_result_agent_id, NEW.tool_result_description, NEW.meta_title,
        NEW.meta_cwd, NEW.meta_repository_url, NEW.message_preview
    FROM __TRACE_SCHEMA__.trace_payload_fields(NEW.payload, NEW.event_type) AS f;
    RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trace_events_project_payload_fields ON __TRACE_SCHEMA__.trace_events;
CREATE TRIGGER trace_events_project_payload_fields BEFORE INSERT OR UPDATE ON __TRACE_SCHEMA__.trace_events
FOR EACH ROW EXECUTE FUNCTION __TRACE_SCHEMA__.project_trace_payload_fields_before_write();
