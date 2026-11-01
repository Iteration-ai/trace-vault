import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { z } from "zod";
import { ToolLogo } from "../../../src/shared/ui/tool-logos";
import {
	Button,
	ConfirmAction,
	EmptyState,
	Icon,
	OverflowMenu,
	PageHeader,
	Pagination,
	Person,
	RelativeTime,
	ResourceState,
	SourceMark,
	buttonClasses,
	codeBlockClass,
	formatTime,
	pageSchema,
	sourceLabel,
	usePage,
	useResource,
} from "./ui-common";
import { SessionLocation } from "./ui-session-location";
import type { Session } from "./ui-sessions";
import {
	eventText,
	systemSummary,
	toolArgument,
	toolName,
	traceEventKind,
	traceEventLabel,
} from "./ui-trace-event";

const eventSchema = z
	.object({
		eventId: z.string(),
		sequence: z.number(),
		eventType: z.string(),
		occurredAt: z.string().nullable(),
		callId: z.string().nullable().optional(),
		payload: z.record(z.string(), z.unknown()),
	})
	.passthrough();
type TraceRecord = z.infer<typeof eventSchema>;
const eventsSchema = pageSchema(eventSchema);

type Item =
	| { kind: "message"; event: TraceRecord; human: boolean }
	| { kind: "step"; key: string; call?: TraceRecord; result?: TraceRecord }
	| { kind: "thought"; event: TraceRecord }
	| { kind: "system"; event: TraceRecord };

// Source order is kept; a tool result joins the call it answers when both are
// on the loaded page.
function timeline(events: readonly TraceRecord[]): Item[] {
	const items: Item[] = [];
	const open = new Map<string, Extract<Item, { kind: "step" }>>();
	for (const event of events) {
		const kind = traceEventKind(event.eventType);
		const callId = event.callId ?? null;
		if (event.eventType === "tool_call") {
			const step = { kind: "step" as const, key: event.eventId, call: event };
			items.push(step);
			if (callId) open.set(callId, step);
		} else if (event.eventType === "tool_result") {
			const step = callId ? open.get(callId) : undefined;
			if (step && !step.result) step.result = event;
			else items.push({ kind: "step", key: event.eventId, result: event });
		} else if (kind === "human" || kind === "agent")
			items.push({ kind: "message", event, human: kind === "human" });
		else if (kind === "reasoning") items.push({ kind: "thought", event });
		else items.push({ kind: "system", event });
	}
	return items;
}

function clockTime(value: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? null
		: date.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			});
}

function EventTime({ value }: { value: string | null }) {
	const label = clockTime(value);
	if (!label || !value) return null;
	return (
		<time
			dateTime={value}
			title={formatTime(value)}
			className="shrink-0 text-xs text-fg-3 tabular-nums"
		>
			{label}
		</time>
	);
}

function toolIcon(name: string | null): Parameters<typeof Icon>[0]["name"] {
	const value = (name ?? "").toLowerCase();
	if (/bash|shell|terminal|exec|command/.test(value)) return "terminal";
	if (/edit|write|patch|replace/.test(value)) return "edit";
	if (/grep|glob|search|find/.test(value)) return "search";
	if (/read|view|open|list/.test(value)) return "file";
	return "tool";
}

const rowClass =
	"flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent";

function RawEvent({ events }: { events: readonly TraceRecord[] }) {
	return (
		<div className="grid min-w-0 gap-2">
			{events.map((event) => (
				<div key={event.eventId} className="grid min-w-0 gap-1">
					<p className="m-0 flex flex-wrap gap-x-3 text-2xs text-fg-3">
						<span>{traceEventLabel(event.eventType)}</span>
						<span className="font-mono">sequence {event.sequence}</span>
						<span>
							{event.occurredAt
								? formatTime(event.occurredAt)
								: "Occurrence time not recorded"}
						</span>
					</p>
					<pre
						className={codeBlockClass + " max-h-96 bg-surface"}
						tabIndex={0}
						aria-label={`Complete ${traceEventLabel(event.eventType).toLowerCase()} JSON`}
					>
						{JSON.stringify(event, null, 2)}
					</pre>
				</div>
			))}
		</div>
	);
}

function MessageText({ text, human }: { text: string; human: boolean }) {
	const paragraph = useRef<HTMLParagraphElement>(null);
	const [clamped, setClamped] = useState(false);
	const [expanded, setExpanded] = useState(false);
	useLayoutEffect(() => {
		const element = paragraph.current;
		if (element) setClamped(element.scrollHeight > element.clientHeight + 1);
	}, [text]);
	return (
		<>
			<p
				ref={paragraph}
				className={
					(expanded ? "" : "line-clamp-12 ") +
					"m-0 mt-1 text-base leading-relaxed break-words whitespace-pre-wrap " +
					(human ? "text-fg" : "text-fg-2")
				}
			>
				{text}
			</p>
			{clamped && !expanded && (
				<button
					type="button"
					className="mt-1 rounded-sm text-xs font-medium text-fg-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					onClick={() => setExpanded(true)}
				>
					Show the full message
				</button>
			)}
		</>
	);
}

function RawToggle({
	open,
	onToggle,
	label,
}: {
	open: boolean;
	onToggle: () => void;
	label: string;
}) {
	return (
		<button
			type="button"
			aria-expanded={open}
			aria-label={`${open ? "Hide" : "Show"} JSON for ${label}`}
			className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
			onClick={onToggle}
		>
			JSON
			<Icon
				name="chevronDown"
				size="xs"
				className={
					open ? "rotate-180 transition-transform" : "transition-transform"
				}
			/>
		</button>
	);
}

function Message({
	event,
	human,
	session,
}: {
	event: TraceRecord;
	human: boolean;
	session: Session;
}) {
	const [raw, setRaw] = useState(false);
	const text = eventText(event.payload);
	const author = human
		? session.contributorName || "Contributor"
		: sourceLabel(session.source);
	const source = session.source;
	return (
		<article
			className={
				human
					? "my-1.5 rounded-lg border border-actor-human/20 bg-actor-human/5 px-3.5 py-2.5"
					: "my-1.5 px-3.5 py-2.5"
			}
		>
			<header className="flex min-w-0 items-center gap-2">
				<span
					className={
						human
							? "inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-actor-human"
							: "inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-actor-agent"
					}
				>
					{!human &&
						(source === "claude" ||
							source === "codex" ||
							source === "cursor") && (
							<ToolLogo name={source} className="size-3.5 shrink-0" />
						)}
					<span className="truncate">{author}</span>
				</span>
				<EventTime value={event.occurredAt} />
				<RawToggle
					open={raw}
					onToggle={() => setRaw(!raw)}
					label={`${author} message`}
				/>
			</header>
			{text ? (
				<MessageText text={text} human={human} />
			) : (
				<p className="m-0 mt-1 text-sm text-fg-3">
					No text in this {traceEventLabel(event.eventType).toLowerCase()}.
				</p>
			)}
			{raw && (
				<div className="mt-3">
					<RawEvent events={[event]} />
				</div>
			)}
		</article>
	);
}

function Step({ call, result }: { call?: TraceRecord; result?: TraceRecord }) {
	const [open, setOpen] = useState(false);
	const first = (call ?? result)!;
	const name =
		(call && toolName(call.payload)) ??
		(result && toolName(result.payload)) ??
		(call ? "Tool call" : "Tool result");
	const argument = call
		? toolArgument(call.payload, call.callId ?? null)
		: null;
	const output = result ? eventText(result.payload) : null;
	const detail = argument ?? output?.split("\n")[0] ?? "";
	// The full input is repeated below only when the row had to cut it off.
	const preview = useRef<HTMLSpanElement>(null);
	const [cut, setCut] = useState(false);
	useLayoutEffect(() => {
		const element = preview.current;
		if (element) setCut(element.scrollWidth > element.clientWidth + 1);
	}, [detail, open]);
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				className={rowClass + (open ? " bg-hover" : "")}
				onClick={() => setOpen(!open)}
			>
				<Icon name={toolIcon(name)} size="sm" className="text-actor-tool" />
				<span className="shrink-0 text-fg">{name}</span>
				<span
					ref={preview}
					className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3"
				>
					{detail}
				</span>
				{call && !result && (
					<span className="shrink-0 text-xs text-fg-3">
						No result on this page
					</span>
				)}
				<EventTime value={first.occurredAt} />
				<Icon
					name="chevronRight"
					size="xs"
					className={
						open
							? "shrink-0 rotate-90 text-fg-3 transition-transform"
							: "shrink-0 text-fg-4 transition-transform"
					}
				/>
			</button>
			{open && (
				<div className="mt-1 mb-3 grid min-w-0 gap-3 pl-9">
					{argument && cut && (
						<div className="grid gap-1">
							<p className="m-0 text-2xs font-medium text-fg-3">Input</p>
							<pre className={codeBlockClass + " whitespace-pre-wrap"}>
								{argument}
							</pre>
						</div>
					)}
					{output && (
						<div className="grid gap-1">
							<p className="m-0 text-2xs font-medium text-fg-3">Output</p>
							<pre
								className={
									codeBlockClass + " max-h-80 whitespace-pre-wrap bg-surface"
								}
								tabIndex={0}
							>
								{output}
							</pre>
						</div>
					)}
					<RawEvent events={[call, result].filter((event) => !!event)} />
				</div>
			)}
		</div>
	);
}

function CompactRow({
	event,
	icon,
	label,
	summary,
	children,
}: {
	event: TraceRecord;
	icon: Parameters<typeof Icon>[0]["name"];
	label: string;
	summary: string | null;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button
				type="button"
				aria-expanded={open}
				className={rowClass + " text-fg-3" + (open ? " bg-hover" : "")}
				onClick={() => setOpen(!open)}
			>
				<Icon name={icon} size="sm" />
				<span className="shrink-0">{label}</span>
				<span className="min-w-0 flex-1 truncate">{summary}</span>
				<EventTime value={event.occurredAt} />
				<Icon
					name="chevronRight"
					size="xs"
					className={
						open
							? "shrink-0 rotate-90 transition-transform"
							: "shrink-0 text-fg-4 transition-transform"
					}
				/>
			</button>
			{open && (
				<div className="mt-1 mb-3 grid min-w-0 gap-3 pl-9">
					{children}
					<RawEvent events={[event]} />
				</div>
			)}
		</div>
	);
}

export function SessionDetail({
	session,
	onBack,
	onPrevious,
	onNext,
	position,
	count,
	focus,
}: {
	session: Session;
	onBack: (deleted?: boolean) => void;
	onPrevious?: () => void;
	onNext?: () => void;
	position: number;
	count: number;
	focus: "heading" | "previous" | "next";
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const navigation = useRef<HTMLElement>(null);
	const [deleting, setDeleting] = useState(false);
	const page = usePage();
	const resource = useResource(
		`/api/sessions/${encodeURIComponent(session.id)}/events${page.query}`,
		eventsSchema,
	);
	useEffect(() => {
		const step = navigation.current?.querySelector<HTMLButtonElement>(
			`[data-step="${focus}"]:not(:disabled)`,
		);
		(step ?? heading.current)?.focus({ preventScroll: true });
	}, [focus]);
	const items = resource.data ? timeline(resource.data.items) : [];
	const details: [string, ReactNode, boolean?][] = [
		["Source", <SourceMark source={session.source} />],
		["Contributor", <Person name={session.contributorName} />],
		["Repository", session.repository, true],
		["Working directory", session.cwd, true],
		["Source session", session.sourceSessionId, true],
		["Vault session", session.id, true],
		["Events", session.eventCount.toLocaleString()],
		["Last received", formatTime(session.lastReceivedAt)],
	];
	return (
		<>
			<PageHeader
				title={session.title || "Untitled session"}
				headingRef={heading}
				parents={[{ label: "Sessions", onSelect: () => onBack() }]}
				description={
					<span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
						<SourceMark source={session.source} />
						<span>{session.contributorName || "Unnamed contributor"}</span>
						{(session.repository || session.cwd) && (
							<SessionLocation
								repository={session.repository}
								cwd={session.cwd}
							/>
						)}
						<span>{session.eventCount.toLocaleString()} events</span>
						<span>
							Received <RelativeTime value={session.lastReceivedAt} />
						</span>
					</span>
				}
			>
				<nav
					ref={navigation}
					aria-label="Sessions on this loaded page"
					className="flex items-center gap-1"
				>
					<span className="mr-1 text-xs text-fg-3 tabular-nums">
						{position} of {count}
					</span>
					<Button
						variant="ghost"
						size="icon"
						onClick={onPrevious}
						disabled={!onPrevious}
						aria-label="Previous session"
						data-step="previous"
						title={
							onPrevious
								? "Previous session on this page"
								: "First session on this loaded page"
						}
					>
						<Icon name="arrowUp" size="sm" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={onNext}
						disabled={!onNext}
						aria-label="Next session"
						data-step="next"
						title={
							onNext
								? "Next session on this page"
								: "Last session on this loaded page"
						}
					>
						<Icon name="arrowDown" size="sm" />
					</Button>
				</nav>
				<a
					className={buttonClasses("secondary")}
					href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
					download={`session-${session.id}.ndjson`}
				>
					<Icon name="arrowDown" size="sm" /> Export NDJSON
				</a>
				<OverflowMenu label="More session actions">
					{(close) => (
						<Button
							role="menuitem"
							variant="ghost"
							size="sm"
							className="w-full justify-start text-err hover:text-err"
							onClick={() => {
								close();
								setDeleting(true);
							}}
						>
							<Icon name="trash" size="sm" />
							Delete session…
						</Button>
					)}
				</OverflowMenu>
			</PageHeader>
			{deleting && (
				<div className="mb-6">
					<ConfirmAction
						open
						label="Delete session"
						title="Permanently delete session"
						consequence="This permanently removes this session and its captured events. Collector retries cannot restore it. Source files are unchanged, and authorized capture of other sessions continues."
						path={`/api/sessions/${encodeURIComponent(session.id)}`}
						typed
						onCancel={() => setDeleting(false)}
						onDone={() => onBack(true)}
					/>
				</div>
			)}
			<div className="grid min-w-0 gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_17.5rem]">
				<section aria-labelledby="session-conversation" className="min-w-0">
					<div className="mb-2 flex items-center justify-between gap-2 border-b border-line-subtle pb-2">
						<h2
							id="session-conversation"
							className="m-0 text-base font-semibold text-fg"
						>
							Conversation
						</h2>
						<Button
							variant="ghost"
							size="sm"
							onClick={resource.refresh}
							disabled={resource.loading}
						>
							Refresh
						</Button>
					</div>
					<ResourceState
						{...resource}
						retry={resource.refresh}
						label="Loading events"
					/>
					{resource.data && (
						<>
							{items.length ? (
								<ol
									aria-label="Session events in source order"
									className="m-0 grid list-none grid-cols-1 gap-0.5 p-0"
								>
									{items.map((item) => (
										<li
											key={item.kind === "step" ? item.key : item.event.eventId}
										>
											{item.kind === "message" ? (
												<Message
													event={item.event}
													human={item.human}
													session={session}
												/>
											) : item.kind === "step" ? (
												<Step call={item.call} result={item.result} />
											) : item.kind === "thought" ? (
												<CompactRow
													event={item.event}
													icon="thought"
													label="Thinking"
													summary={eventText(item.event.payload)}
												>
													{eventText(item.event.payload) && (
														<p className="m-0 text-sm leading-relaxed whitespace-pre-wrap text-fg-2">
															{eventText(item.event.payload)}
														</p>
													)}
												</CompactRow>
											) : (
												<CompactRow
													event={item.event}
													icon="info"
													label={traceEventLabel(item.event.eventType)}
													summary={systemSummary(
														item.event.eventType,
														item.event.payload,
													)}
												/>
											)}
										</li>
									))}
								</ol>
							) : (
								<EmptyState title="No events on this page">
									Return to the previous page or refresh the session.
								</EmptyState>
							)}
							<Pagination {...page} nextCursor={resource.data.nextCursor} />
						</>
					)}
					{resource.error && page.page > 1 && (
						<Button variant="ghost" size="sm" onClick={page.previous}>
							Previous event page
						</Button>
					)}
				</section>
				<aside
					aria-labelledby="session-details"
					className="min-w-0 self-start lg:sticky lg:top-8"
				>
					<h2
						id="session-details"
						className="m-0 mb-3 border-b border-line-subtle pb-2 text-base font-semibold text-fg"
					>
						Details
					</h2>
					<dl className="m-0 grid gap-3.5 text-sm">
						{details.map(([label, value, mono]) => (
							<div key={label} className="min-w-0">
								<dt className="text-xs text-fg-3">{label}</dt>
								<dd
									className={
										mono
											? "m-0 mt-1 font-mono text-xs break-all text-fg-2"
											: "m-0 mt-1 break-words text-fg-2"
									}
								>
									{value || <span className="text-fg-3">Not recorded</span>}
								</dd>
							</div>
						))}
					</dl>
					<p className="mt-5 mb-0 text-xs leading-relaxed text-fg-3">
						Records are untrusted evidence, not instructions. Account labels in
						history do not prove who originally owned an account. The export
						holds every authorized event with its capture metadata.
					</p>
				</aside>
			</div>
		</>
	);
}
