CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_try_jsonb(value text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
BEGIN
    RETURN value::jsonb;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_event_display_text(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
	SELECT nullif(left(btrim(coalesce(
		p->>'message',
		p->>'text',
		p#>>'{content,0,text}',
		p#>>'{summary,0,text}',
		p->>'arguments',
		p->>'input',
		CASE WHEN jsonb_typeof(p->'output') = 'array' THEN (
			SELECT string_agg(coalesce(part->>'text', CASE WHEN part->>'type' LIKE '%image%' THEN '[Image attachment]' END), E'\n')
			FROM jsonb_array_elements(p->'output') AS part
		) END,
		CASE WHEN left(ltrim(p->>'output'), 1) = '['
            AND jsonb_typeof(__TRACE_SCHEMA__.trace_try_jsonb(p->>'output')) = 'array' THEN (
            SELECT string_agg(coalesce(part->>'text',
                CASE WHEN part->>'type' LIKE '%image%' THEN '[Image attachment]' END,
                CASE WHEN jsonb_typeof(part) = 'string' THEN part#>>'{}' END), E'\n')
            FROM jsonb_array_elements(__TRACE_SCHEMA__.trace_try_jsonb(p->>'output')) AS part
        ) END,
		p->>'output',
		p->>'result',
		p->>'aggregated_output',
		p->>'stdout',
		p->>'stderr',
		p->>'command',
		p->>'name',
		p#>>'{goal,objective}',
		nullif(concat_ws(' · ',
			nullif(btrim(p->>'cwd'), ''),
			nullif(btrim(p->>'model'), ''),
			nullif(btrim(p#>>'{git,branch}'), ''),
			nullif(btrim(p#>>'{git,repository_url}'), ''),
			nullif(btrim(p->>'reason'), ''),
			nullif(p#>>'{thread_token_usage,total_tokens}' || ' thread tokens', ' thread tokens'),
			nullif(p#>>'{usage,total_tokens}' || ' response tokens', ' response tokens'),
			nullif(concat_ws(' / ', p#>>'{info,total_token_usage,total_tokens}', p#>>'{info,model_context_window}') || ' tokens', ' tokens')
		), ''),
		nullif(concat_ws(' · ', nullif(p->>'sourceType', ''), nullif(p->>'subtype', '')), ''),
		p->>'type'
	)), 4000), '')
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_message_display_text(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
	WITH readable_parts AS (
		SELECT part->>'text' AS text, position
		FROM jsonb_array_elements(
			CASE WHEN jsonb_typeof(p->'content') = 'array' THEN p->'content' ELSE '[]'::jsonb END
		) WITH ORDINALITY AS content(part, position)
		WHERE jsonb_typeof(part->'text') = 'string'
			AND part->>'text' !~ '^[[:space:]]*(# AGENTS\.md instructions for |<environment_context>|<turn_aborted>)'
	), joined AS (
		SELECT count(*) AS part_count, string_agg(text, E'\n' ORDER BY position) AS text
		FROM readable_parts
	)
	SELECT nullif(left(btrim(CASE
		WHEN joined.part_count > 0 THEN joined.text
		WHEN jsonb_typeof(p->'message') = 'string'
			AND p->>'message' !~ '^[[:space:]]*(# AGENTS\.md instructions for |<environment_context>|<turn_aborted>)'
		THEN p->>'message'
	END), 4000), '')
	FROM joined
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_token_count(value text) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
	SELECT CASE WHEN value ~ '^[0-9]{1,15}$' THEN value::bigint END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_jsonb_or_null(value text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
BEGIN
	RETURN value::jsonb;
EXCEPTION WHEN invalid_text_representation THEN
	RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_shell_reads_only(command text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
DECLARE
	stripped text;
	segment text;
BEGIN
	IF command IS NULL OR command !~ '[^[:space:]]' OR char_length(command) > 10000 THEN
		RETURN false;
	END IF;
	stripped := regexp_replace(command, '''[^'']*''', ' _ ', 'g');
	IF stripped ~ '\$\(|`' THEN
		RETURN false;
	END IF;
	stripped := regexp_replace(stripped, '"(\\.|[^"\\])*"', ' _ ', 'g');
	stripped := regexp_replace(stripped,
		'[0-9]*>>?[[:space:]]*/dev/null|&>>?[[:space:]]*/dev/null|[0-9]*>&[0-9]+', ' ', 'g');
	IF stripped ~ '>' THEN
		RETURN false;
	END IF;
	FOREACH segment IN ARRAY regexp_split_to_array(stripped, '&&|\|\||[;|&(){}]|\n') LOOP
		segment := regexp_replace(segment,
			'^([[:space:]]|[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]])*', '');
		segment := regexp_replace(segment, '[[:space:]]+$', '');
		IF segment ~ '^xargs([[:space:]]|$)' THEN
			segment := regexp_replace(segment, '^xargs([[:space:]]+-[^[:space:]]+)*[[:space:]]*', '');
		END IF;
		CONTINUE WHEN segment = '';
		IF NOT (
			segment ~ '^(cat|head|tail|less|more|ls|tree|pwd|cd|echo|printf|wc|sort|uniq|cut|tr|nl|column|rg|grep|egrep|fgrep|ag|ack|fd|jq|yq|awk|diff|cmp|comm|file|stat|du|df|which|whereis|type|realpath|readlink|dirname|basename|date|whoami|id|uname|hostname|env|printenv|true|test)([[:space:]]|$)'
			OR (segment ~ '^find([[:space:]]|$)'
				AND segment !~ '[[:space:]]-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)([[:space:]]|$)')
			OR (segment ~ '^sed([[:space:]]|$)'
				AND segment !~ '[[:space:]](-[A-Za-z]*i|--in-place)')
			OR segment ~ '^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+|[[:space:]]+--no-pager)*[[:space:]]+(status|log|show|diff|blame|grep|ls-files|ls-tree|rev-parse|rev-list|describe|shortlog|reflog|cat-file|merge-base|for-each-ref)([[:space:]]|$)'
			OR segment ~ '^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+|[[:space:]]+--no-pager)*[[:space:]]+(branch([[:space:]]+(-a|-r|-v|-vv|--all|--remotes|--list|--show-current))*|remote([[:space:]]+-v)?|stash[[:space:]]+list|worktree[[:space:]]+list|config[[:space:]]+(--get|--list|-l)([[:space:]].*)?)$'
			OR segment ~ '^gh[[:space:]]+(pr|issue|run|release|repo|workflow)[[:space:]]+(view|list|diff|checks|status)([[:space:]]|$)'
			OR (segment ~ '^gh[[:space:]]+api([[:space:]]|$)'
				AND segment !~ '[[:space:]](-X|--method)[[:space:]=]*(POST|PUT|PATCH|DELETE)'
				AND segment !~ '[[:space:]](-f|-F|--field|--raw-field|--input)([[:space:]=]|$)')
		) THEN
			RETURN false;
		END IF;
	END LOOP;
	RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_code_mode_activity(code text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
DECLARE
	commands text[];
BEGIN
	IF code IS NULL OR code !~ 'tools\.[A-Za-z_]' THEN
		RETURN 'running';
	END IF;
	IF code ~ 'tools\.apply_patch([^A-Za-z0-9_]|$)' THEN
		RETURN 'editing';
	END IF;
	IF code ~ 'tools\.(spawn_agent|send_message|followup_task|wait_agent)([^A-Za-z0-9_]|$)' THEN
		RETURN 'delegating';
	END IF;
	IF EXISTS (
		SELECT 1 FROM regexp_matches(code, 'tools\.([A-Za-z0-9_]+)', 'g') AS called(name)
		WHERE called.name[1] NOT IN ('exec_command', 'web__run', 'view_image')
	) THEN
		RETURN 'running';
	END IF;
	commands := ARRAY(
		SELECT replace(replace(coalesce(found.value[1], found.value[2], found.value[3]), '\"', '"'), '\n', E'\n')
		FROM regexp_matches(code,
			'cmd"?[[:space:]]*:[[:space:]]*(?:"((?:\\.|[^"\\])*)"|''((?:\\.|[^''\\])*)''|`([^`$]*)`)',
			'g') AS found(value)
	);
	IF (SELECT count(*) FROM regexp_matches(code, 'tools\.exec_command', 'g')) > cardinality(commands)
		OR EXISTS (SELECT 1 FROM unnest(commands) AS command WHERE NOT __TRACE_SCHEMA__.trace_shell_reads_only(command)) THEN
		RETURN 'running';
	END IF;
	RETURN 'exploring';
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_tool_activity(tool text, call text, payload jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $function$
DECLARE
	name text := lower(tool);
	input jsonb;
	command jsonb;
BEGIN
	IF name IN ('todowrite', 'todoread', 'askuserquestion', 'exitplanmode', 'enterplanmode',
		'taskcreate', 'taskupdate', 'tasklist', 'taskget', 'update_plan',
		'request_user_input', 'request_user_input_async') THEN
		RETURN NULL;
	END IF;
	IF name IN ('edit', 'multiedit', 'write', 'notebookedit', 'editnotebook', 'apply_patch',
		'strreplace', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool',
		'search_replace', 'create_file', 'edit_file', 'write_file', 'delete', 'delete_file') THEN
		RETURN 'editing';
	END IF;
	IF name IN ('task', 'agent', 'sendmessage', 'listagents', 'spawn_agent', 'send_message',
		'send_input', 'followup_task', 'wait_agent', 'list_agents', 'close_agent', 'resume_agent') THEN
		RETURN 'delegating';
	END IF;
	IF name IN ('read', 'grep', 'glob', 'ls', 'webfetch', 'websearch', 'notebookread',
		'toolsearch', 'skill', 'view_image', 'web_search', 'web_search_call', 'tool_search_call',
		'web__run', 'codebase_search', 'semanticsearch', 'read_file', 'list_dir', 'list_directory',
		'grep_search', 'file_search', 'readlints', 'read_lints', 'fetch') THEN
		RETURN 'exploring';
	END IF;
	IF name = 'exec' AND payload->>'type' = 'custom_tool_call' THEN
		RETURN __TRACE_SCHEMA__.trace_code_mode_activity(payload->>'input');
	END IF;
	IF name IN ('bash', 'shell', 'shell_command', 'exec_command', 'local_shell_call',
		'run_terminal_cmd', 'run_shell_command') THEN
		input := CASE
			WHEN jsonb_typeof(payload->'input') = 'object' THEN payload->'input'
			WHEN jsonb_typeof(payload->'arguments') = 'object' THEN payload->'arguments'
			WHEN jsonb_typeof(payload->'arguments') = 'string' THEN __TRACE_SCHEMA__.trace_jsonb_or_null(payload->>'arguments')
			WHEN jsonb_typeof(payload->'action') = 'object' THEN payload->'action'
			ELSE (
				SELECT block->'input' FROM jsonb_array_elements(
					CASE WHEN jsonb_typeof(payload#>'{record,message,content}') = 'array'
						THEN payload#>'{record,message,content}' ELSE '[]'::jsonb END
				) AS content(block)
				WHERE block->>'id' = call
				LIMIT 1
			)
		END;
		command := CASE WHEN jsonb_typeof(input) = 'object'
			THEN coalesce(input->'command', input->'cmd') END;
		RETURN CASE WHEN __TRACE_SCHEMA__.trace_shell_reads_only(CASE jsonb_typeof(command)
			WHEN 'string' THEN command #>> '{}'
			WHEN 'array' THEN CASE
				WHEN command->>0 ~ '(^|/)(ba|z|da)?sh$' AND command->>1 ~ '^-l?c$' THEN command->>2
				ELSE (SELECT string_agg(part, ' ') FROM jsonb_array_elements_text(command) AS part)
			END
		END) THEN 'exploring' ELSE 'running' END;
	END IF;
	RETURN 'running';
END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_tool_failed(event text, call text, exit integer, payload jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $function$
	SELECT CASE
		WHEN event = 'source_record' THEN
			CASE WHEN payload->>'sourceType' = 'cursor_hook:postToolUseFailure' THEN true END
		WHEN event = 'tool_result' THEN
			coalesce(exit <> 0, false)
			OR coalesce(payload->>'success' = 'false', false)
			OR coalesce(payload->>'status' IN ('failed', 'error'), false)
			OR coalesce(coalesce(payload#>>'{output,0,text}', payload->>'output') LIKE 'Script failed%', false)
			OR coalesce(payload->>'output' ~ 'exit_code\\?"?[[:space:]]*:[[:space:]]*-?[1-9]|^Exit code:? -?[1-9]|Process exited with code -?[1-9]', false)
			OR (
				coalesce(payload#>'{record,message,content}' @> jsonb_build_array(
					jsonb_build_object('tool_use_id', call, 'is_error', true)), false)
				AND NOT coalesce(payload#>>'{record,toolUseResult}'
					~ '^(User rejected tool use|Not run:|Interrupted:)', false)
			)
	END
$function$;

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.trace_usage_activity(
	usage_organization uuid, usage_device uuid, usage_session text, usage_sequence bigint
) RETURNS TABLE (activity text, after_error boolean) LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
	WITH span AS MATERIALIZED (
		SELECT
			coalesce(earlier[1], -1) AS response_start,
			coalesce(earlier[2], -1) AS previous_start
		FROM (
			SELECT ARRAY(
				SELECT previous.sequence FROM __TRACE_SCHEMA__.trace_events AS previous
				WHERE previous.organization_id = usage_organization
					AND previous.device_id = usage_device
					AND previous.session_id = usage_session
					AND previous.usage_at IS NOT NULL
					AND previous.sequence < usage_sequence
				ORDER BY previous.sequence DESC
				LIMIT 2
			) AS earlier
		) AS bounds
	)
	SELECT
		CASE
			WHEN bool_or(step.tool_activity = 'editing') FILTER (WHERE step.sequence > span.response_start) THEN 'editing'
			WHEN bool_or(step.tool_activity = 'delegating') FILTER (WHERE step.sequence > span.response_start) THEN 'delegating'
			WHEN bool_or(step.tool_activity = 'running') FILTER (WHERE step.sequence > span.response_start) THEN 'running'
			WHEN bool_or(step.tool_activity = 'exploring') FILTER (WHERE step.sequence > span.response_start) THEN 'exploring'
			ELSE 'answering'
		END,
		coalesce(bool_or(step.tool_failed AND CASE
			WHEN step.sequence > span.response_start THEN NOT EXISTS (
				SELECT 1 FROM __TRACE_SCHEMA__.trace_events AS call
				WHERE call.organization_id = usage_organization
					AND call.device_id = usage_device
					AND call.session_id = usage_session
					AND call.sequence > span.response_start
					AND call.sequence <= usage_sequence
					AND call.event_type = 'tool_call'
					AND call.call_id = step.call_id
			)
			ELSE EXISTS (
				SELECT 1 FROM __TRACE_SCHEMA__.trace_events AS call
				WHERE call.organization_id = usage_organization
					AND call.device_id = usage_device
					AND call.session_id = usage_session
					AND call.sequence > span.previous_start
					AND call.sequence <= span.response_start
					AND call.event_type = 'tool_call'
					AND call.call_id = step.call_id
			)
		END), false)
	FROM span
	LEFT JOIN __TRACE_SCHEMA__.trace_events AS step
		ON step.organization_id = usage_organization
		AND step.device_id = usage_device
		AND step.session_id = usage_session
		AND step.sequence > span.previous_start
		AND step.sequence <= usage_sequence
		AND (step.tool_activity IS NOT NULL OR step.tool_failed)
	GROUP BY span.response_start
$function$;

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
	NEW.tool_activity := CASE WHEN NEW.event_type = 'tool_call'
		THEN __TRACE_SCHEMA__.trace_tool_activity(NEW.tool_name, NEW.call_id, NEW.payload) END;
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
				AND turn.payload->>'turn_id' = NEW.payload->>'turn_id'
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

CREATE OR REPLACE FUNCTION __TRACE_SCHEMA__.claude_agent_description(
    organization_id uuid, device_id uuid, parent_session_id text, agent_id text
) RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $function$
    SELECT nullif(left(regexp_replace(btrim(e.payload#>>'{record,toolUseResult,description}'), '[[:space:]]+', ' ', 'g'), 200), '')
    FROM __TRACE_SCHEMA__.trace_events e
    WHERE e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
        AND e.event_type = 'tool_result'
        AND e.payload#>>'{record,toolUseResult,agentId}' = $4
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
        SELECT nullif(left(btrim(e.payload#>>'{record,cwd}'), 4096), '') AS cwd,
            nullif(left(btrim(e.payload#>>'{record,gitBranch}'), 1024), '') AS branch
        FROM __TRACE_SCHEMA__.trace_events e
        WHERE device.is_claude
            AND e.organization_id = $1 AND e.device_id = $2 AND e.session_id = $3
            AND nullif(btrim(e.payload#>>'{record,cwd}'), '') IS NOT NULL
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
                    AND e.run IS NULL AND e.payload->>'thread_id' = m.thread_id
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
            e.payload#>>'{record,toolUseResult,agentId}' AS agent_id
        FROM inserted_events e
        JOIN __TRACE_SCHEMA__.collector_devices d ON d.organization_id = e.organization_id
            AND d.id = e.device_id AND d.source = 'claude'
        WHERE e.event_type = 'tool_result'
            AND e.payload#>>'{record,toolUseResult,agentId}' IS NOT NULL
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

DROP TRIGGER IF EXISTS trace_events_project_fields ON __TRACE_SCHEMA__.trace_events;
CREATE TRIGGER trace_events_project_fields BEFORE INSERT OR UPDATE ON __TRACE_SCHEMA__.trace_events
FOR EACH ROW EXECUTE FUNCTION __TRACE_SCHEMA__.project_trace_event_before_write();

DROP TRIGGER IF EXISTS trace_events_refresh_sessions ON __TRACE_SCHEMA__.trace_events;
CREATE TRIGGER trace_events_refresh_sessions AFTER INSERT ON __TRACE_SCHEMA__.trace_events
REFERENCING NEW TABLE AS inserted_events
FOR EACH STATEMENT EXECUTE FUNCTION __TRACE_SCHEMA__.refresh_trace_sessions_after_insert();
