-- Readers use the columns SQL 0003 projects instead of other rows' payloads,
-- so a host can store payloads outside PostgreSQL. A row written before SQL
-- 0003 has no columns until a backfill or the move of its payload fills them,
-- and is read from its payload meanwhile; a row whose payload moved always
-- has them. A row with a payload location written on insert keeps its
-- projections and no payload.

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.project_trace_event_before_write() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
	parent_value text;
	exit_value text;
	context_value text;
	tokens_value text;
	usage jsonb;
	output_tokens bigint;
	cached_tokens bigint;
BEGIN
	-- A payload stored outside PostgreSQL keeps the fields projected when it was written.
	IF NEW.payload IS NULL THEN
		RETURN NEW;
	END IF;
	NEW.display_text := CASE
		WHEN NEW.event_type IN ('user_message', 'assistant_message') THEN coalesce(
			__TRACE_SCHEMA__.trace_message_display_text(NEW.payload),
			nullif(left(btrim(NEW.payload->>'text'), 4000), '')
		)
		ELSE __TRACE_SCHEMA__.trace_event_display_text(NEW.payload)
	END;
	NEW.is_instruction := NEW.event_type = 'user_message'
		AND NEW.display_text IS NULL
		AND (
			coalesce(NEW.payload->>'message', '')
				~ '^[[:space:]]*(# AGENTS\.md instructions for |<environment_context>|<INSTRUCTIONS>|<turn_aborted>)'
			OR EXISTS (
				SELECT 1 FROM jsonb_array_elements(
					CASE WHEN jsonb_typeof(NEW.payload->'content') = 'array'
						THEN NEW.payload->'content' ELSE '[]'::jsonb END
				) AS content(part)
				WHERE part->>'text'
					~ '^[[:space:]]*(# AGENTS\.md instructions for |<environment_context>|<INSTRUCTIONS>|<turn_aborted>)'
			)
		);
	NEW.tool_name := nullif(left(coalesce(NEW.payload->>'name', NEW.payload->>'tool', NEW.payload->>'command', NEW.payload->>'type'), 120), '');
	exit_value := coalesce(NEW.payload->>'exit_code', NEW.payload->>'exitCode');
	NEW.exit_code := CASE WHEN exit_value ~ '^-?[0-9]{1,9}$' THEN exit_value::integer END;
	NEW.tool_failed := __TRACE_SCHEMA__.trace_tool_failed(NEW.event_type, NEW.call_id, NEW.exit_code, NEW.payload);
	NEW.model := nullif(left(NEW.payload->>'model', 120), '');
	context_value := NEW.payload#>>'{info,model_context_window}';
	NEW.context_window := CASE WHEN context_value ~ '^[0-9]{1,10}$' THEN context_value::bigint END;
	tokens_value := NEW.payload#>>'{usage,total_tokens}';
	NEW.total_tokens := CASE WHEN tokens_value ~ '^[0-9]{1,12}$' THEN tokens_value::bigint END;
	-- One model response's token usage, split by how the provider bills it.
	-- Codex reports cached tokens inside its input count; Claude and Cursor
	-- report uncached input, cache reads, and cache writes separately.
	NEW.usage_at := NULL;
	NEW.usage_input_tokens := NULL;
	NEW.usage_cache_read_tokens := NULL;
	NEW.usage_cache_write_tokens := NULL;
	NEW.usage_cache_write_long_tokens := NULL;
	NEW.usage_output_tokens := NULL;
	usage := CASE WHEN NEW.event_type = 'token_usage_record'
		AND jsonb_typeof(NEW.payload->'usage') = 'object' THEN NEW.payload->'usage' END;
	output_tokens := __TRACE_SCHEMA__.trace_token_count(usage->>'output_tokens');
	IF output_tokens IS NOT NULL THEN
		NEW.usage_output_tokens := output_tokens;
		IF usage ? 'cached_input_tokens' THEN
			cached_tokens := coalesce(__TRACE_SCHEMA__.trace_token_count(usage->>'cached_input_tokens'), 0);
			NEW.usage_cache_read_tokens := cached_tokens;
			NEW.usage_input_tokens := greatest(coalesce(__TRACE_SCHEMA__.trace_token_count(usage->>'input_tokens'), 0) - cached_tokens, 0);
			NEW.usage_cache_write_tokens := 0;
			NEW.usage_cache_write_long_tokens := 0;
		ELSE
			NEW.usage_input_tokens := coalesce(__TRACE_SCHEMA__.trace_token_count(usage->>'input_tokens'), 0);
			NEW.usage_cache_read_tokens := coalesce(
				__TRACE_SCHEMA__.trace_token_count(usage->>'cache_read_input_tokens'),
				__TRACE_SCHEMA__.trace_token_count(usage->>'cache_read_tokens'), 0);
			NEW.usage_cache_write_tokens := coalesce(
				__TRACE_SCHEMA__.trace_token_count(usage->>'cache_creation_input_tokens'),
				__TRACE_SCHEMA__.trace_token_count(usage->>'cache_write_tokens'), 0);
			NEW.usage_cache_write_long_tokens := least(
				coalesce(__TRACE_SCHEMA__.trace_token_count(usage#>>'{cache_creation,ephemeral_1h_input_tokens}'), 0),
				NEW.usage_cache_write_tokens);
		END IF;
		NEW.usage_at := coalesce(NEW.occurred_at::timestamptz, NEW.ingested_at);
		-- Codex names the model on the turn, not on each response.
		IF NEW.model IS NULL AND nullif(NEW.payload->>'turn_id', '') IS NOT NULL THEN
			SELECT turn.model INTO NEW.model FROM __TRACE_SCHEMA__.trace_events AS turn
			WHERE turn.organization_id = NEW.organization_id
				AND turn.device_id = NEW.device_id
				AND turn.session_id = NEW.session_id
				AND turn.event_type = 'turn_context'
				AND (turn.turn_id = NEW.payload->>'turn_id' OR turn.payload->>'turn_id' = NEW.payload->>'turn_id')
				AND turn.model IS NOT NULL
			LIMIT 1;
		END IF;
	END IF;
	NEW.pull_request_url := CASE WHEN NEW.event_type = 'source_record'
		AND NEW.payload->>'sourceType' = 'pr-link'
		AND NEW.payload#>>'{record,prUrl}' ~ '^https://[^[:space:]]+$'
		AND char_length(NEW.payload#>>'{record,prUrl}') <= 2048
		THEN NEW.payload#>>'{record,prUrl}' END;
	NEW.thread_id := NULL;
	NEW.parent_thread_id := NULL;
	NEW.agent_path := NULL;
	NEW.agent_nickname := NULL;
	NEW.launch_cwd := NULL;
	NEW.launch_branch := NULL;
	NEW.launch_repository_url := NULL;
	NEW.launch_commit_hash := NULL;
	NEW.is_run_start := false;
	NEW.run_start_ordinal := NULL;
	IF NEW.run->>'kind' = 'identity' THEN
		NEW.thread_id := NEW.run->>'id';
		NEW.parent_thread_id := NEW.run->>'parentId';
		NEW.is_run_start := NEW.run->>'ownStart' = 'true';
		IF NEW.run->>'startOrdinal' ~ '^[0-9]{1,16}$' THEN
			NEW.run_start_ordinal := (NEW.run->>'startOrdinal')::bigint;
		END IF;
	ELSIF NEW.event_type = 'session_meta'
		AND NEW.payload->>'id' = right(NEW.session_id, 36)
		AND NEW.payload->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
		NEW.thread_id := NEW.payload->>'id';
		parent_value := coalesce(NEW.payload->>'parent_thread_id', NEW.payload#>>'{source,subagent,thread_spawn,parent_thread_id}');
		IF char_length(parent_value) BETWEEN 1 AND 200 THEN
			NEW.parent_thread_id := parent_value;
		END IF;
		IF NEW.payload->>'subagent_history_start_ordinal' ~ '^[0-9]{1,16}$' THEN
			NEW.run_start_ordinal := (NEW.payload->>'subagent_history_start_ordinal')::bigint;
		END IF;
		IF EXISTS (
			SELECT 1 FROM __TRACE_SCHEMA__.collector_devices d WHERE d.organization_id = NEW.organization_id
				AND d.id = NEW.device_id AND d.source = 'claude'
		) THEN
			NEW.is_run_start := true;
			IF NEW.parent_thread_id IS NOT NULL
				AND nullif(NEW.payload->>'agentId', '') IS NOT NULL
				AND char_length(NEW.parent_thread_id || '/agent/' || (NEW.payload->>'agentId')) <= 200 THEN
				NEW.thread_id := NEW.parent_thread_id || '/agent/' || (NEW.payload->>'agentId');
			END IF;
		END IF;
	END IF;
	IF NEW.run->>'kind' = 'start' THEN
		NEW.is_run_start := true;
		IF NEW.run->>'sourceOrdinal' ~ '^[0-9]{1,16}$' THEN
			NEW.run_start_ordinal := (NEW.run->>'sourceOrdinal')::bigint;
		END IF;
	ELSIF NEW.run IS NULL AND NEW.event_type = 'thread_settings_applied'
		AND NEW.payload->>'thread_id' = right(NEW.session_id, 36) THEN
		NEW.is_run_start := true;
	END IF;
	IF NEW.thread_id IS NOT NULL THEN
		NEW.agent_path := nullif(left(coalesce(NEW.payload->>'agent_path', NEW.payload#>>'{source,subagent,thread_spawn,agent_path}'), 500), '');
		NEW.agent_nickname := nullif(left(coalesce(NEW.payload->>'agent_nickname', NEW.payload#>>'{source,subagent,thread_spawn,agent_nickname}'), 160), '');
		NEW.launch_cwd := nullif(left(btrim(NEW.payload->>'cwd'), 4096), '');
		NEW.launch_branch := nullif(left(btrim(NEW.payload#>>'{git,branch}'), 1024), '');
		NEW.launch_repository_url := nullif(left(btrim(NEW.payload#>>'{git,repository_url}'), 2048), '');
		NEW.launch_commit_hash := nullif(left(btrim(NEW.payload#>>'{git,commit_hash}'), 160), '');
	END IF;
	RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.project_trace_payload_fields_before_write() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    -- A payload stored outside PostgreSQL keeps the fields projected when it was written.
    IF NEW.payload IS NULL THEN
        RETURN NEW;
    END IF;
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

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.claude_agent_description(
    organization_id uuid, device_id uuid, parent_session_id text, agent_id text
) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
    SELECT nullif(left(regexp_replace(btrim(coalesce(e.tool_result_description, e.payload#>>'{record,toolUseResult,description}')), '[[:space:]]+', ' ', 'g'), 200), '')
    FROM __TRACE_SCHEMA__.trace_events e
    WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
        AND e.event_type = 'tool_result'
        AND (e.tool_result_agent_id = $4 OR e.payload#>>'{record,toolUseResult,agentId}' = $4)
    ORDER BY e.sequence, e.event_id LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_session_read_projection(
    organization_id uuid, device_id uuid, session_id text,
    inserted_sequences bigint[] DEFAULT NULL
) RETURNS TABLE (
    thread_id text, parent_thread_id text, agent_path text, agent_nickname text,
    agent_description text,
    launch_cwd text, launch_branch text, launch_repository_url text,
    launch_commit_hash text, user_message_preview text, own_start_sequence bigint,
    own_event_count bigint
) LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
    SELECT m.thread_id, m.parent_thread_id, m.agent_path, m.agent_nickname,
        CASE WHEN device.is_claude AND m.parent_thread_id IS NOT NULL
            THEN __TRACE_SCHEMA__.claude_agent_description($1, $2, 'claude:' || m.parent_thread_id, split_part(m.thread_id, '/agent/', 2))
        END,
        CASE WHEN device.is_claude
            THEN coalesce(claude_launch.cwd, m.launch_cwd, launch_context.cwd)
            ELSE coalesce(m.launch_cwd, launch_context.cwd) END,
        CASE WHEN device.is_claude
            THEN coalesce(claude_launch.branch, m.launch_branch, launch_context.branch)
            ELSE coalesce(m.launch_branch, launch_context.branch) END,
        coalesce(m.launch_repository_url, repository_context.repository_url,
            parent_repository_context.repository_url),
        m.launch_commit_hash,
        first_message.preview, boundary.sequence, own_count.event_count
    FROM (SELECT 1) AS anchor
    CROSS JOIN LATERAL (
        SELECT EXISTS (
            SELECT 1 FROM __TRACE_SCHEMA__.collector_devices d
            WHERE d.organization_id = $1 AND d.id = $2 AND d.source = 'claude'
        ) AS is_claude
    ) AS device
    LEFT JOIN LATERAL (
        SELECT e.thread_id, e.parent_thread_id, e.agent_path, e.agent_nickname,
            e.launch_cwd, e.launch_branch, e.launch_repository_url, e.launch_commit_hash,
            e.run_start_ordinal, e.sequence AS identity_sequence,
            e.is_run_start AS identity_is_start, e.run IS NOT NULL AS explicit_identity
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND e.thread_id IS NOT NULL
        ORDER BY e.sequence, e.event_id LIMIT 1
    ) AS m ON true
    LEFT JOIN LATERAL (
        SELECT nullif(left(btrim(coalesce(e.record_cwd, e.payload#>>'{record,cwd}')), 4096), '') AS cwd,
            nullif(left(btrim(coalesce(e.record_git_branch, e.payload#>>'{record,gitBranch}')), 1024), '') AS branch
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE device.is_claude
            AND e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND nullif(btrim(coalesce(e.record_cwd, e.payload#>>'{record,cwd}')), '') IS NOT NULL
        ORDER BY e.sequence, e.event_id LIMIT 1
    ) AS claude_launch ON true
    LEFT JOIN LATERAL (
        SELECT e.launch_cwd AS cwd, e.launch_branch AS branch
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND e.event_type = 'session_meta' AND e.launch_cwd IS NOT NULL
        ORDER BY e.sequence, e.event_id LIMIT 1
    ) AS launch_context ON true
    LEFT JOIN LATERAL (
        SELECT e.launch_repository_url AS repository_url
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND e.event_type = 'session_meta' AND e.launch_repository_url IS NOT NULL
            AND e.launch_cwd = coalesce(claude_launch.cwd, m.launch_cwd, launch_context.cwd)
        ORDER BY e.sequence, e.occurred_at NULLS LAST, e.event_id LIMIT 1
    ) AS repository_context ON true
    LEFT JOIN LATERAL (
        SELECT e.launch_repository_url AS repository_url
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE device.is_claude AND m.parent_thread_id IS NOT NULL
            AND e.organization_id = $1 AND e.device_id = $2
            AND e.session_id = 'claude:' || m.parent_thread_id
            AND e.event_type = 'session_meta' AND e.launch_repository_url IS NOT NULL
            AND e.launch_cwd = coalesce(claude_launch.cwd, m.launch_cwd, launch_context.cwd)
        ORDER BY e.sequence, e.occurred_at NULLS LAST, e.event_id LIMIT 1
    ) AS parent_repository_context ON true
    LEFT JOIN LATERAL (
        SELECT CASE WHEN m.thread_id IS NULL THEN NULL::bigint
            WHEN m.parent_thread_id IS NULL THEN 0::bigint
            WHEN m.identity_is_start THEN m.identity_sequence
            WHEN m.explicit_identity THEN (
                SELECT min(e.sequence) FROM __TRACE_SCHEMA__.trace_events e
                WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                    AND e.is_run_start AND e.run->>'kind' = 'start'
                    AND e.run_start_ordinal = m.run_start_ordinal
            )
            ELSE (
                SELECT min(e.sequence) FROM __TRACE_SCHEMA__.trace_events e
                WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                    AND e.is_run_start
                    AND e.run IS NULL AND coalesce(e.payload_thread_id, e.payload->>'thread_id') = m.thread_id
            ) END AS sequence
    ) AS boundary ON true
    LEFT JOIN LATERAL (
        SELECT nullif(left(regexp_replace(e.display_text, '[[:space:]]+', ' ', 'g'), 200), '') AS preview
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND e.event_type = 'user_message' AND NOT e.is_instruction
            AND e.display_text IS NOT NULL AND e.sequence >= boundary.sequence
        ORDER BY e.sequence, e.event_id LIMIT 1
    ) AS first_message ON true
    LEFT JOIN __TRACE_SCHEMA__.trace_sessions AS previous
        ON previous.organization_id = $1 AND previous.device_id = $2 AND previous.session_id = $3
    LEFT JOIN LATERAL (
        SELECT CASE
            WHEN boundary.sequence IS NULL THEN 0::bigint
            WHEN $4 IS NOT NULL AND previous.own_start_sequence = boundary.sequence
                THEN previous.own_event_count + (
                    SELECT count(*) FROM unnest($4) AS inserted(sequence)
                    WHERE inserted.sequence >= boundary.sequence
                )
            ELSE (
                SELECT count(*) FROM __TRACE_SCHEMA__.trace_events e
                WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                    AND e.sequence >= boundary.sequence
            )
        END AS event_count
    ) AS own_count ON true
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.refresh_trace_sessions_after_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    -- Direct inserts must share the API's session lock before reading prior counts.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        session.organization_id::text || ':' || session.user_id::text || ':' || session.session_id, 0
    ))
    FROM (
        SELECT DISTINCT organization_id, user_id, session_id
        FROM inserted_events ORDER BY organization_id, user_id, session_id
    ) AS session;
    WITH counts AS (
        SELECT organization_id, device_id, user_id, session_id, count(*) AS event_count,
            min(occurred_at) AS first_occurred_at, max(occurred_at) AS last_occurred_at,
            min(ingested_at) AS first_received_at, max(ingested_at) AS last_received_at,
            array_agg(sequence) AS inserted_sequences
        FROM inserted_events
        GROUP BY organization_id, device_id, user_id, session_id
    )
    INSERT INTO __TRACE_SCHEMA__.trace_sessions AS trace_sessions (
        organization_id, device_id, user_id, session_id, event_count,
        first_occurred_at, last_occurred_at, first_received_at, last_received_at,
        thread_id, parent_thread_id, agent_path, agent_nickname, agent_description,
        launch_cwd, launch_branch, launch_repository_url, launch_commit_hash,
        user_message_preview, own_start_sequence, own_event_count
    )
    SELECT c.organization_id, c.device_id, c.user_id, c.session_id, c.event_count,
        c.first_occurred_at, c.last_occurred_at, c.first_received_at, c.last_received_at,
        p.thread_id, p.parent_thread_id, p.agent_path, p.agent_nickname, p.agent_description,
        p.launch_cwd, p.launch_branch, p.launch_repository_url, p.launch_commit_hash,
        p.user_message_preview, p.own_start_sequence, p.own_event_count
    FROM counts c CROSS JOIN LATERAL __TRACE_SCHEMA__.trace_session_read_projection(
        c.organization_id, c.device_id, c.session_id, c.inserted_sequences
    ) p
    ON CONFLICT (organization_id, device_id, session_id) DO UPDATE SET
        event_count = trace_sessions.event_count + EXCLUDED.event_count,
        first_occurred_at = least(trace_sessions.first_occurred_at, EXCLUDED.first_occurred_at),
        last_occurred_at = greatest(trace_sessions.last_occurred_at, EXCLUDED.last_occurred_at),
        first_received_at = least(trace_sessions.first_received_at, EXCLUDED.first_received_at),
        last_received_at = greatest(trace_sessions.last_received_at, EXCLUDED.last_received_at),
        thread_id = EXCLUDED.thread_id,
        parent_thread_id = EXCLUDED.parent_thread_id,
        agent_path = EXCLUDED.agent_path,
        agent_nickname = EXCLUDED.agent_nickname,
        agent_description = EXCLUDED.agent_description,
        launch_cwd = EXCLUDED.launch_cwd,
        launch_branch = EXCLUDED.launch_branch,
        launch_repository_url = EXCLUDED.launch_repository_url,
        launch_commit_hash = EXCLUDED.launch_commit_hash,
        user_message_preview = EXCLUDED.user_message_preview,
        own_start_sequence = EXCLUDED.own_start_sequence,
        own_event_count = EXCLUDED.own_event_count;
    WITH launched AS (
        SELECT DISTINCT e.organization_id, e.user_id, e.device_id, e.session_id,
            coalesce(e.tool_result_agent_id, e.payload#>>'{record,toolUseResult,agentId}') AS agent_id
        FROM inserted_events e
        JOIN __TRACE_SCHEMA__.collector_devices d ON d.organization_id = e.organization_id
            AND d.id = e.device_id AND d.source = 'claude'
        WHERE e.event_type = 'tool_result'
            AND coalesce(e.tool_result_agent_id, e.payload#>>'{record,toolUseResult,agentId}') IS NOT NULL
    )
    UPDATE __TRACE_SCHEMA__.trace_sessions AS child
    SET agent_description = __TRACE_SCHEMA__.claude_agent_description(
        launched.organization_id, launched.device_id, launched.session_id, launched.agent_id
    )
    FROM launched
    WHERE child.organization_id = launched.organization_id
        AND child.user_id = launched.user_id
        AND child.device_id = launched.device_id
        AND child.thread_id = substr(launched.session_id, 8) || '/agent/' || launched.agent_id;
    WITH parent_git AS (
        SELECT DISTINCT e.organization_id, e.device_id, e.thread_id,
            e.launch_cwd, e.launch_repository_url
        FROM inserted_events e
        JOIN __TRACE_SCHEMA__.collector_devices d ON d.organization_id = e.organization_id
            AND d.id = e.device_id AND d.source = 'claude'
        WHERE e.event_type = 'session_meta'
            AND e.parent_thread_id IS NULL
            AND e.thread_id IS NOT NULL
            AND e.launch_cwd IS NOT NULL
            AND e.launch_repository_url IS NOT NULL
    )
    UPDATE __TRACE_SCHEMA__.trace_sessions AS child
    SET launch_repository_url = parent_git.launch_repository_url
    FROM parent_git
    WHERE child.organization_id = parent_git.organization_id
        AND child.device_id = parent_git.device_id
        AND child.parent_thread_id = parent_git.thread_id
        AND child.launch_cwd = parent_git.launch_cwd
        AND child.launch_repository_url IS NULL;
    RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_session_presentation(
    organization_id uuid, device_id uuid, session_id text
) RETURNS TABLE (source_title text, first_user_message_preview text, source_cwd text, source_repository_url text)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
    SELECT
        (SELECT __TRACE_SCHEMA__.trace_compact_text(coalesce(e.meta_title, CASE WHEN jsonb_typeof(e.payload->'title') = 'string' THEN e.payload->>'title' END))
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND coalesce(e.meta_title, CASE WHEN jsonb_typeof(e.payload->'title') = 'string' THEN e.payload->>'title' END) IS NOT NULL
                AND __TRACE_SCHEMA__.trace_compact_text(coalesce(e.meta_title, CASE WHEN jsonb_typeof(e.payload->'title') = 'string' THEN e.payload->>'title' END)) IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1),
        (SELECT coalesce(e.message_preview, __TRACE_SCHEMA__.trace_message_preview(e.payload))
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'user_message'
                AND coalesce(e.message_preview, __TRACE_SCHEMA__.trace_message_preview(e.payload)) IS NOT NULL
            ORDER BY e.sequence, e.event_id COLLATE "C" LIMIT 1),
        (SELECT btrim(coalesce(e.meta_cwd, CASE WHEN jsonb_typeof(e.payload->'cwd') = 'string' THEN e.payload->>'cwd' END))
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND coalesce(e.meta_cwd, CASE WHEN jsonb_typeof(e.payload->'cwd') = 'string' THEN e.payload->>'cwd' END) IS NOT NULL
                AND __TRACE_SCHEMA__.trace_compact_text(coalesce(e.meta_cwd, CASE WHEN jsonb_typeof(e.payload->'cwd') = 'string' THEN e.payload->>'cwd' END)) IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1),
        (SELECT btrim(coalesce(e.meta_repository_url, CASE WHEN jsonb_typeof(e.payload#>'{git,repository_url}') = 'string' THEN e.payload#>>'{git,repository_url}' END))
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND coalesce(e.meta_repository_url, CASE WHEN jsonb_typeof(e.payload#>'{git,repository_url}') = 'string' THEN e.payload#>>'{git,repository_url}' END) IS NOT NULL
                AND __TRACE_SCHEMA__.trace_compact_text(coalesce(e.meta_repository_url, CASE WHEN jsonb_typeof(e.payload#>'{git,repository_url}') = 'string' THEN e.payload#>>'{git,repository_url}' END)) IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1)
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.store_trace_payload_externally() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
    IF NEW.payload_object IS NOT NULL THEN
        NEW.payload := NULL;
    END IF;
    RETURN NEW;
END
$function$;

-- PostgreSQL runs same-kind triggers alphabetically: every projection reads the
-- payload before this trigger removes it.
DROP TRIGGER IF EXISTS trace_events_zz_store_payload_externally ON __TRACE_SCHEMA__.trace_events;
CREATE TRIGGER trace_events_zz_store_payload_externally BEFORE INSERT OR UPDATE ON __TRACE_SCHEMA__.trace_events
FOR EACH ROW EXECUTE FUNCTION __TRACE_SCHEMA__.store_trace_payload_externally();
