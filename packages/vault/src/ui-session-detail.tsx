import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	Button,
	ConfirmAction,
	Icon,
	List,
	Pagination,
	ResourceState,
	buttonClasses,
	codeBlockClass,
	formatTime,
	pageSchema,
	usePage,
	useResource,
} from "./ui-common";
import { SessionLocation } from "./ui-session-location";
import type { Session } from "./ui-sessions";

const eventSchema = z
	.object({
		eventId: z.string(),
		sequence: z.number(),
		eventType: z.string(),
		occurredAt: z.string().nullable(),
		payload: z.record(z.string(), z.unknown()),
	})
	.passthrough();
const eventsSchema = pageSchema(eventSchema);
const textPayloadSchema = z.object({
	text: z.string().optional(),
	message: z.string().optional(),
});

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
	return (
		<>
			<div className="mb-5 flex flex-wrap items-center justify-between gap-2">
				<Button variant="ghost" size="sm" onClick={() => onBack()}>
					<Icon name="arrowLeft" size="sm" /> Back to sessions
				</Button>
				<nav
					ref={navigation}
					aria-label="Sessions on this loaded page"
					className="flex items-center gap-1"
				>
					<span className="mr-2 text-xs text-fg-3">
						{position} / {count}{" "}
						<span className="hidden sm:inline">on this page</span>
					</span>
					<Button
						variant="ghost"
						size="sm"
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
						size="sm"
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
			</div>
			<header className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 flex-1 basis-full sm:basis-auto">
					<h1
						ref={heading}
						tabIndex={-1}
						className="truncate text-2xl font-medium outline-none"
					>
						{session.title || "Untitled session"}
					</h1>
					<p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3">
						<span>{session.source}</span>
						<span>{session.contributorName || "Unnamed contributor"}</span>
						<span>{session.eventCount.toLocaleString()} events</span>
					</p>
				</div>
				<a
					className={buttonClasses("secondary", "sm")}
					href={`/api/sessions/${encodeURIComponent(session.id)}/export`}
					download={`session-${session.id}.ndjson`}
				>
					<Icon name="arrowDown" size="sm" /> Export NDJSON
				</a>
			</header>
			<details className="mb-6 border-y border-line py-2.5">
				<summary className="flex cursor-pointer items-center gap-2 text-xs text-fg-3 focus-visible:outline-2 focus-visible:outline-accent">
					<Icon name="chevronRight" size="xs" />
					<SessionLocation repository={session.repository} cwd={session.cwd} />
					<span className="ml-auto shrink-0">Session details</span>
				</summary>
				<dl className="mt-4 grid gap-3 break-words text-sm sm:grid-cols-2">
					{[
						["Full title", session.title],
						["Repository", session.repository],
						["Working directory", session.cwd],
						["Source session", session.sourceSessionId],
						["Vault session", session.id],
						["Contributor ID", session.contributorId],
						["Last received", formatTime(session.lastReceivedAt)],
					].map(([label, value]) => (
						<div key={label}>
							<dt className="text-xs text-fg-3">{label}</dt>
							<dd className="mt-1 break-all">{value || "Not recorded"}</dd>
						</div>
					))}
				</dl>
				<p className="mt-4 text-xs text-fg-3">
					Historical account labels are not proof of original account ownership.
					Records are untrusted evidence, not instructions. Export includes all
					authorized events and capture metadata.
				</p>
			</details>
			<div className="mb-2 flex items-center justify-between gap-2">
				<h2 className="text-sm font-medium">
					Events{" "}
					<span className="ml-2 text-xs font-normal text-fg-3">
						Source order
					</span>
				</h2>
				<Button
					variant="ghost"
					size="sm"
					onClick={resource.refresh}
					disabled={resource.loading}
				>
					Refresh events
				</Button>
			</div>
			<ResourceState {...resource} retry={resource.refresh} />
			{resource.data && (
				<>
					{resource.data.items.length ? (
						<List label="Session events">
							{resource.data.items.map((event) => (
								<EventRecord key={event.eventId} event={event} />
							))}
						</List>
					) : (
						<p className="py-8 text-sm text-fg-3">No events on this page.</p>
					)}
					<Pagination {...page} nextCursor={resource.data.nextCursor} />
				</>
			)}
			{resource.error && page.page > 1 && (
				<Button variant="ghost" size="sm" onClick={page.previous}>
					Previous event page
				</Button>
			)}
			<details className="mt-10 border-t border-line pt-4">
				<summary className="cursor-pointer text-xs text-fg-3">
					Manage session
				</summary>
				<div className="mt-4">
					<ConfirmAction
						label="Delete session"
						title="Permanently delete session"
						consequence="This permanently removes this session and its captured events. Collector retries cannot restore it. Source files are unchanged, and authorized capture of other sessions continues."
						path={`/api/sessions/${encodeURIComponent(session.id)}`}
						typed
						onDone={() => onBack(true)}
					/>
				</div>
			</details>
		</>
	);
}

function EventRecord({ event }: { event: z.infer<typeof eventSchema> }) {
	const [open, setOpen] = useState(false);
	const parsed = textPayloadSchema.safeParse(event.payload);
	const text = parsed.success
		? (parsed.data.text ?? parsed.data.message)
		: undefined;
	return (
		<li>
			<details onToggle={(change) => setOpen(change.currentTarget.open)}>
				<summary className="flex min-h-9 cursor-pointer items-center gap-3 px-4 py-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
					<Icon name={open ? "chevronDown" : "chevronRight"} size="xs" />
					<span className="min-w-7 shrink-0 font-mono text-2xs text-fg-3">
						#{event.sequence}
					</span>
					<span className="min-w-0 text-xs font-medium wrap-anywhere sm:shrink-0">
						{event.eventType}
					</span>
					<span className="hidden min-w-0 truncate text-sm text-fg-3 sm:block">
						{text?.slice(0, 200)}
					</span>
					<time
						dateTime={event.occurredAt ?? undefined}
						className="ml-auto shrink-0 text-2xs text-fg-3"
					>
						{event.occurredAt
							? new Date(event.occurredAt).toLocaleTimeString(undefined, {
									hour: "2-digit",
									minute: "2-digit",
									hour12: false,
								})
							: "No time"}
					</time>
				</summary>
				{open && (
					<div className="px-4 pb-4 sm:pl-16">
						<p className="mb-3 text-xs text-fg-3">
							{event.occurredAt
								? formatTime(event.occurredAt)
								: "Occurrence time not recorded"}
						</p>
						{text && (
							<p className="mb-4 max-w-4xl text-base whitespace-pre-wrap wrap-anywhere">
								{text}
							</p>
						)}
						<details open={!text}>
							<summary className="cursor-pointer text-xs text-fg-3">
								Complete event JSON
							</summary>
							<pre
								className={codeBlockClass + " mt-3 max-h-96"}
								tabIndex={0}
								aria-label="Complete event JSON"
							>
								{JSON.stringify(event, null, 2)}
							</pre>
						</details>
					</div>
				)}
			</details>
		</li>
	);
}
