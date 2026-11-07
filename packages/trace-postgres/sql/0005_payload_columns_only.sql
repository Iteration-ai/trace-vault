-- Readers use only the columns SQL 0003 projects. Rows written before it
-- that still hold their payload are projected here first; a host that moved
-- payloads out of PostgreSQL projected each row as it moved it.
UPDATE __TRACE_SCHEMA__.trace_events AS e SET payload = e.payload
WHERE e.payload IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM __TRACE_SCHEMA__.trace_payload_fields(e.payload, e.event_type) AS f
    WHERE (e.turn_id, e.payload_thread_id, e.record_cwd, e.record_git_branch,
        e.tool_result_agent_id, e.tool_result_description, e.meta_title,
        e.meta_cwd, e.meta_repository_url, e.message_preview)
    IS NOT DISTINCT FROM (f.turn_id, f.payload_thread_id, f.record_cwd, f.record_git_branch,
        f.tool_result_agent_id, f.tool_result_description, f.meta_title,
        f.meta_cwd, f.meta_repository_url, f.message_preview)
);

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.claude_agent_description(
    organization_id uuid, device_id uuid, parent_session_id text, agent_id text
) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
    SELECT nullif(left(regexp_replace(btrim(e.tool_result_description), '[[:space:]]+', ' ', 'g'), 200), '')
    FROM __TRACE_SCHEMA__.trace_events e
    WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
        AND e.event_type = 'tool_result'
        AND e.tool_result_agent_id = $4
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
        SELECT nullif(left(btrim(e.record_cwd), 4096), '') AS cwd,
            nullif(left(btrim(e.record_git_branch), 1024), '') AS branch
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE device.is_claude
            AND e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND nullif(btrim(e.record_cwd), '') IS NOT NULL
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
                    AND e.run IS NULL AND e.payload_thread_id = m.thread_id
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
            e.tool_result_agent_id AS agent_id
        FROM inserted_events e
        JOIN __TRACE_SCHEMA__.collector_devices d ON d.organization_id = e.organization_id
            AND d.id = e.device_id AND d.source = 'claude'
        WHERE e.event_type = 'tool_result'
            AND e.tool_result_agent_id IS NOT NULL
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
        (SELECT __TRACE_SCHEMA__.trace_compact_text(e.meta_title)
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND e.meta_title IS NOT NULL
                AND __TRACE_SCHEMA__.trace_compact_text(e.meta_title) IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1),
        (SELECT e.message_preview
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'user_message'
                AND e.message_preview IS NOT NULL
            ORDER BY e.sequence, e.event_id COLLATE "C" LIMIT 1),
        (SELECT btrim(e.meta_cwd)
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND e.meta_cwd IS NOT NULL
                AND __TRACE_SCHEMA__.trace_compact_text(e.meta_cwd) IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1),
        (SELECT btrim(e.meta_repository_url)
            FROM __TRACE_SCHEMA__.trace_events e
            WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
                AND e.event_type = 'session_meta' AND e.meta_repository_url IS NOT NULL
                AND __TRACE_SCHEMA__.trace_compact_text(e.meta_repository_url) IS NOT NULL
            ORDER BY e.sequence DESC, e.event_id COLLATE "C" DESC LIMIT 1)
$function$;
