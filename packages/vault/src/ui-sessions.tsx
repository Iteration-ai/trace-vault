import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	Button,
	EmptyState,
	PageHeader,
	Pagination,
	Person,
	RelativeTime,
	ResourceState,
	SourceMark,
	pageSchema,
	tableFrameClass,
	usePage,
	useResource,
	type Member,
} from "./ui-common";
import { SessionDetail } from "./ui-session-detail";
import { SessionLocation } from "./ui-session-location";

const sessionSchema = z.object({
	id: z.string(),
	source: z.string(),
	sourceSessionId: z.string(),
	contributorId: z.string(),
	contributorName: z.string(),
	title: z.string().nullable(),
	lastReceivedAt: z.string(),
	eventCount: z.number(),
	cwd: z.string().nullable(),
	repository: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;
const sessionsSchema = pageSchema(sessionSchema);

// Admins see every contributor, so their ledger gains a contributor column.
const sessionColumnClasses = {
	admin:
		"lg:grid-cols-[minmax(0,2.6fr)_minmax(0,1.2fr)_minmax(0,1fr)_72px_104px]",
	member: "lg:grid-cols-[minmax(0,2.6fr)_minmax(0,1.2fr)_72px_104px]",
} as const;

const sessionHeaderClass =
	"hidden h-9 items-center gap-4 border-b border-line px-4 text-xs font-medium text-fg-3 lg:grid";

const sessionRowClass =
	"group grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left text-fg-2 transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent";

export function Sessions({
	member,
	onCollectors,
}: {
	member: Member;
	onCollectors: () => void;
}) {
	const page = usePage();
	const resource = useResource(`/api/sessions${page.query}`, sessionsSchema);
	const [selection, setSelection] = useState<{
		session: Session;
		focus: "heading" | "previous" | "next";
	}>();
	const selected = selection?.session;
	const collection = useRef<HTMLDivElement>(null);
	const returnTo = useRef<{ id: string; scroll: number } | undefined>(
		undefined,
	);
	const rows = resource.data?.items ?? [];
	const index = rows.findIndex((session) => session.id === selected?.id);
	const admin = member.role === "admin";
	const columns = sessionColumnClasses[admin ? "admin" : "member"];
	useLayoutEffect(() => {
		if (selected) {
			window.scrollTo(0, 0);
			return;
		}
		if (!returnTo.current) {
			collection.current?.focus({ preventScroll: true });
			return;
		}
		const { id, scroll } = returnTo.current;
		const button = collection.current?.querySelector<HTMLButtonElement>(
			`[data-session-id="${CSS.escape(id)}"]`,
		);
		button?.focus({ preventScroll: true });
		window.scrollTo(0, scroll);
		button?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	function open(
		session: Session,
		focus: "heading" | "previous" | "next" = "heading",
	) {
		returnTo.current = {
			id: session.id,
			scroll: selected ? (returnTo.current?.scroll ?? 0) : window.scrollY,
		};
		setSelection({ session, focus });
	}
	return (
		<>
			<div
				ref={collection}
				hidden={!!selected}
				tabIndex={-1}
				role="region"
				aria-label="Session collection"
				className="outline-none"
			>
				<PageHeader
					title="Sessions"
					description={admin ? undefined : "Sessions you contributed"}
				>
					<Button
						variant="secondary"
						onClick={resource.refresh}
						disabled={resource.loading}
					>
						Refresh
					</Button>
				</PageHeader>
				<ResourceState
					{...resource}
					retry={resource.refresh}
					label="Loading sessions"
				/>
				{resource.data && (
					<>
						{rows.length === 0 ? (
							page.page === 1 ? (
								<EmptyState
									title="No sessions yet"
									action={
										<Button variant="primary" onClick={onCollectors}>
											Set up a collector
										</Button>
									}
								>
									Sessions appear here once a collector sends approved Claude
									Code, Codex or Cursor work to this vault.
								</EmptyState>
							) : (
								<EmptyState title="No sessions on this page">
									Return to the previous page or refresh the archive.
								</EmptyState>
							)
						) : (
							<div className={tableFrameClass}>
								<div
									aria-hidden="true"
									className={sessionHeaderClass + " " + columns}
								>
									<span>Session</span>
									<span>Location</span>
									{admin && <span>Contributor</span>}
									<span className="text-right">Events</span>
									<span>Received</span>
								</div>
								<ul
									aria-label="Trace sessions"
									className="m-0 list-none divide-y divide-line-subtle p-0"
								>
									{rows.map((session) => (
										<li key={session.id}>
											<SessionRow
												session={session}
												admin={admin}
												columns={columns}
												onOpen={() => open(session)}
											/>
										</li>
									))}
								</ul>
							</div>
						)}
						<Pagination {...page} nextCursor={resource.data.nextCursor} />
					</>
				)}
				{resource.error && page.page > 1 && (
					<Button variant="ghost" size="sm" onClick={page.previous}>
						Previous session page
					</Button>
				)}
			</div>
			{selected && (
				<SessionDetail
					key={selected.id}
					session={selected}
					position={index + 1}
					count={rows.length}
					focus={selection.focus}
					onPrevious={
						index > 0 ? () => open(rows[index - 1]!, "previous") : undefined
					}
					onNext={
						index >= 0 && index < rows.length - 1
							? () => open(rows[index + 1]!, "next")
							: undefined
					}
					onBack={(deleted = false) => {
						if (deleted) {
							returnTo.current = undefined;
							resource.refresh();
						}
						setSelection(undefined);
					}}
				/>
			)}
		</>
	);
}

function SessionRow({
	session,
	admin,
	columns,
	onOpen,
}: {
	session: Session;
	admin: boolean;
	columns: string;
	onOpen: () => void;
}) {
	const title = session.title || "Untitled session";
	return (
		<button
			type="button"
			data-session-id={session.id}
			className={sessionRowClass + " " + columns}
			aria-label={`Open session ${title}, ${session.id.slice(0, 8)}, ${session.sourceSessionId}, ${session.contributorName}`}
			onClick={onOpen}
		>
			<span className="col-span-2 min-w-0 lg:col-span-1">
				<span
					className={
						session.title
							? "block truncate text-sm font-medium text-fg"
							: "block truncate text-sm text-fg-3"
					}
					title={title}
				>
					{title}
				</span>
				<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-fg-3">
					<SourceMark source={session.source} />
					<span aria-hidden="true">·</span>
					<span className="shrink-0 font-mono">{session.id.slice(0, 8)}</span>
					{admin && (
						<span className="min-w-0 truncate lg:hidden">
							<span aria-hidden="true">· </span>
							{session.contributorName || "Unnamed"}
						</span>
					)}
				</span>
			</span>
			<span className="min-w-0">
				<SessionLocation repository={session.repository} cwd={session.cwd} />
			</span>
			{admin && (
				<span className="hidden min-w-0 text-xs lg:block">
					<Person name={session.contributorName} />
				</span>
			)}
			<span className="hidden text-right text-xs text-fg-3 tabular-nums lg:block">
				{session.eventCount.toLocaleString()}
			</span>
			<span className="text-right text-xs text-fg-3 tabular-nums lg:text-left">
				<RelativeTime value={session.lastReceivedAt} />
			</span>
		</button>
	);
}
