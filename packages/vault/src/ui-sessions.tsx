import { useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	Button,
	Heading,
	Icon,
	Pagination,
	Panel,
	ResourceState,
	formatTime,
	pageSchema,
	tableBodyClass,
	tableClasses,
	tableDenseCellClass,
	tableHeaderCellClass,
	tableHeadRowClass,
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
				<Heading
					title="Sessions"
					description={
						member.role === "admin"
							? "Company archive"
							: "Your contributed traces"
					}
				>
					<div className="flex gap-1">
						<Button
							variant="ghost"
							size="sm"
							onClick={resource.refresh}
							disabled={resource.loading}
						>
							Refresh
						</Button>
						<Button variant="secondary" size="sm" onClick={onCollectors}>
							<Icon name="plus" size="sm" /> Collector
						</Button>
					</div>
				</Heading>
				<ResourceState {...resource} retry={resource.refresh} />
				{resource.data && (
					<>
						{rows.length === 0 ? (
							<Panel>
								<h2 className="text-base font-semibold">
									{page.page === 1
										? "No sessions yet"
										: "No sessions on this page"}
								</h2>
								<p className="mt-2 text-sm text-fg-2">
									{page.page === 1
										? "Connect a collector to bring approved work into your company archive."
										: "Return to the previous page or refresh the archive."}
								</p>
								{page.page === 1 && (
									<div className="mt-4">
										<Button variant="primary" onClick={onCollectors}>
											Set up a collector
										</Button>
									</div>
								)}
							</Panel>
						) : (
							<div className="border-y border-line">
								<table
									className={tableClasses.compact + " table-fixed"}
									aria-label="Trace sessions"
								>
									<colgroup>
										<col />
										<col className="hidden sm:table-column sm:w-1/4" />
										{member.role === "admin" && (
											<col className="hidden lg:table-column lg:w-28" />
										)}
										<col className="hidden xl:table-column xl:w-24" />
										<col className="hidden xl:table-column xl:w-20" />
										<col className="w-24 sm:w-32" />
									</colgroup>
									<thead className="sticky top-0 z-10 bg-canvas">
										<tr className={tableHeadRowClass}>
											<th scope="col" className={tableHeaderCellClass}>
												Session
											</th>
											<th
												scope="col"
												className={
													tableHeaderCellClass + " hidden sm:table-cell"
												}
											>
												Location
											</th>
											{member.role === "admin" && (
												<th
													scope="col"
													className={
														tableHeaderCellClass + " hidden lg:table-cell"
													}
												>
													Contributor
												</th>
											)}
											<th
												scope="col"
												className={
													tableHeaderCellClass + " hidden xl:table-cell"
												}
											>
												Source
											</th>
											<th
												scope="col"
												className={
													tableHeaderCellClass +
													" hidden xl:table-cell text-right"
												}
											>
												Events
											</th>
											<th
												scope="col"
												className={tableHeaderCellClass}
												aria-sort="descending"
												title="Last received, newest first"
											>
												Received
											</th>
										</tr>
									</thead>
									<tbody className={tableBodyClass}>
										{rows.map((session) => (
											<tr
												key={session.id}
												className="cursor-pointer hover:bg-hover focus-within:bg-hover"
												onClick={(event) => {
													if (
														(event.target as HTMLElement).closest("button") ||
														window.getSelection()?.toString() ||
														event.ctrlKey ||
														event.metaKey ||
														event.shiftKey ||
														event.altKey
													)
														return;
													open(session);
												}}
											>
												<td className="h-8 min-w-0 px-1.5 py-0 align-middle">
													<Button
														variant="ghost"
														size="sm"
														className="w-full min-w-0 justify-start"
														data-session-id={session.id}
														aria-label={`Open session ${session.title || "Untitled session"}, ${session.id.slice(0, 8)}, ${session.sourceSessionId}, ${session.contributorName}`}
														onClick={() => open(session)}
													>
														<span
															className={
																session.title
																	? "truncate text-fg"
																	: "truncate text-fg-2"
															}
														>
															{session.title || "Untitled session"}
														</span>
														<span className="shrink-0 font-mono text-2xs text-fg-3">
															{session.id.slice(0, 8)}
														</span>
													</Button>
													<div className="flex min-w-0 items-center gap-2 px-2.5 pb-2 sm:hidden">
														{member.role === "admin" && (
															<span className="max-w-1/3 truncate text-2xs text-fg-3">
																{session.contributorName || "Unnamed"}
															</span>
														)}
														<SessionLocation
															repository={session.repository}
															cwd={session.cwd}
														/>
													</div>
												</td>
												<td
													className={
														tableDenseCellClass + " hidden sm:table-cell"
													}
												>
													<SessionLocation
														repository={session.repository}
														cwd={session.cwd}
													/>
												</td>
												{member.role === "admin" && (
													<td
														className={
															tableDenseCellClass + " hidden lg:table-cell"
														}
													>
														<p className="truncate text-fg-2">
															{session.contributorName || "Unnamed"}
														</p>
													</td>
												)}
												<td
													className={
														tableDenseCellClass + " hidden xl:table-cell"
													}
												>
													<span className="text-fg-3">{session.source}</span>
												</td>
												<td
													className={
														tableDenseCellClass +
														" hidden xl:table-cell text-right"
													}
												>
													<span className="text-fg-3 tabular-nums">
														{session.eventCount.toLocaleString()}
													</span>
												</td>
												<td className={tableDenseCellClass}>
													<time
														dateTime={session.lastReceivedAt}
														title={formatTime(session.lastReceivedAt)}
														className="text-xs text-fg-3 tabular-nums"
													>
														{new Date(
															session.lastReceivedAt,
														).toLocaleDateString(undefined, {
															month: "short",
															day: "numeric",
															year: "2-digit",
														})}{" "}
														<span className="hidden sm:inline">
															{new Date(
																session.lastReceivedAt,
															).toLocaleTimeString(undefined, {
																hour: "2-digit",
																minute: "2-digit",
																hour12: false,
															})}
														</span>
													</time>
												</td>
											</tr>
										))}
									</tbody>
								</table>
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
