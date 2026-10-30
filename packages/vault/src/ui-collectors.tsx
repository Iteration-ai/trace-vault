import { Fragment, useRef, useState } from "react";
import { z } from "zod";
import {
	Button,
	Feedback,
	Field,
	Heading,
	Pagination,
	ResourceState,
	Select,
	api,
	codeBlockClass,
	emptySchema,
	formatTime,
	pageSchema,
	tableBodyClass,
	tableClasses,
	tableDenseCellClass,
	tableHeaderCellClass,
	tableHeadRowClass,
	useAction,
	usePage,
	useResource,
} from "./ui-common";

const devicesSchema = pageSchema(
	z.object({
		id: z.string(),
		name: z.string(),
		source: z.string(),
		memberId: z.string(),
		createdAt: z.string(),
		revoked: z.boolean(),
	}),
);

export function Collectors({ onRules }: { onRules: () => void }) {
	const page = usePage();
	const resource = useResource(`/api/devices${page.query}`, devicesSchema);
	const action = useAction();
	const [setup, setSetup] = useState<boolean | null>(null);
	const [selected, setSelected] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	const [actionTarget, setActionTarget] = useState<string>();
	const feedback = useRef<HTMLDivElement>(null);
	const setupOpen =
		setup ??
		(page.page === 1 &&
			resource.data?.items.length === 0 &&
			!resource.data.nextCursor);
	return (
		<>
			<Heading title="Collectors" description="Collection access to this vault">
				<div className="flex flex-wrap gap-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={resource.loading || action.pending}
						onClick={resource.refresh}
					>
						Refresh
					</Button>
					<Button
						variant="secondary"
						size="sm"
						aria-expanded={!!setupOpen}
						aria-controls="collector-setup"
						onClick={() => setSetup(!setupOpen)}
					>
						Enroll collector
					</Button>
				</div>
			</Heading>
			<section id="collector-setup" hidden={!setupOpen}>
				{setupOpen && <CollectorSetup onRules={onRules} />}
			</section>
			<div ref={feedback} tabIndex={-1} className="grid gap-2">
				{!confirming && (
					<Feedback
						action={{
							...action,
							error: action.error
								? `Collector ${actionTarget}: ${action.error}`
								: undefined,
						}}
					/>
				)}
			</div>
			<ResourceState {...resource} retry={resource.refresh} />
			{resource.data && (
				<>
					{resource.data.items.length ? (
						<table className={tableClasses.compact + " table-fixed"}>
							<caption className="sr-only">Enrolled collectors</caption>
							<thead>
								<tr className={tableHeadRowClass}>
									<th scope="col" className={tableHeaderCellClass}>
										Collector
									</th>
									<th
										scope="col"
										className={
											tableHeaderCellClass + " hidden w-24 sm:table-cell"
										}
									>
										Source
									</th>
									<th
										scope="col"
										className={
											tableHeaderCellClass + " hidden w-32 lg:table-cell"
										}
									>
										Owner
									</th>
									<th
										scope="col"
										className={
											tableHeaderCellClass + " hidden w-48 xl:table-cell"
										}
									>
										Enrolled
									</th>
									<th
										scope="col"
										className={
											tableHeaderCellClass + " hidden w-24 sm:table-cell"
										}
									>
										Access
									</th>
									<th scope="col" className={tableHeaderCellClass + " w-20"}>
										<span className="sr-only">Details</span>
									</th>
								</tr>
							</thead>
							<tbody className={tableBodyClass}>
								{resource.data.items.map((device) => (
									<Fragment key={device.id}>
										<tr
											className={
												selected === device.id
													? "bg-selected"
													: "hover:bg-hover"
											}
										>
											<td className={tableDenseCellClass}>
												<div className="flex min-w-0 items-center gap-2">
													<span className="truncate" title={device.name}>
														{device.name || "Unnamed collector"}
													</span>
													<span className="hidden shrink-0 font-mono text-xs text-fg-3 sm:inline">
														{device.id.slice(0, 8)}
													</span>
												</div>
												<p className="truncate text-xs text-fg-3 sm:hidden">
													{device.source} ·{" "}
													{device.revoked ? "Revoked" : "Enrolled"}
												</p>
											</td>
											<td
												className={
													tableDenseCellClass + " hidden sm:table-cell"
												}
											>
												<span className="block truncate" title={device.source}>
													{device.source}
												</span>
											</td>
											<td
												className={
													tableDenseCellClass + " hidden lg:table-cell"
												}
											>
												<span
													className="block truncate font-mono text-xs text-fg-3"
													title={device.memberId}
												>
													{device.memberId.slice(0, 8)}
												</span>
											</td>
											<td
												className={
													tableDenseCellClass + " hidden xl:table-cell"
												}
											>
												<span
													className="block truncate text-fg-3"
													title={formatTime(device.createdAt)}
												>
													{formatTime(device.createdAt)}
												</span>
											</td>
											<td
												className={
													tableDenseCellClass + " hidden sm:table-cell"
												}
											>
												<span
													className={device.revoked ? "text-warn" : "text-fg-3"}
												>
													{device.revoked ? "Revoked" : "Enrolled"}
												</span>
											</td>
											<td className={tableDenseCellClass}>
												<Button
													variant="ghost"
													size="sm"
													disabled={action.pending}
													aria-label={`Details for ${device.name || "unnamed collector"} (${device.id})`}
													aria-expanded={selected === device.id}
													aria-controls={
														selected === device.id
															? "collector-details"
															: undefined
													}
													onClick={() => {
														setSelected(
															selected === device.id ? undefined : device.id,
														);
														setConfirming(false);
													}}
												>
													{selected === device.id ? "Hide" : "View"}
												</Button>
											</td>
										</tr>
										{selected === device.id && (
											<tr>
												<td colSpan={6}>
													<section
														id="collector-details"
														aria-label="Collector details"
														className="grid gap-3 px-4 py-3 text-sm"
													>
														<p className="break-all font-medium">
															{device.name || "Unnamed collector"}
														</p>
														<dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
															<div>
																<dt className="text-xs text-fg-3">
																	Collector ID
																</dt>
																<dd className="break-all font-mono text-xs">
																	{device.id}
																</dd>
															</div>
															<div>
																<dt className="text-xs text-fg-3">
																	Owner member ID
																</dt>
																<dd className="break-all font-mono text-xs">
																	{device.memberId}
																</dd>
															</div>
															<div>
																<dt className="text-xs text-fg-3">Source</dt>
																<dd className="break-all">{device.source}</dd>
															</div>
															<div>
																<dt className="text-xs text-fg-3">Enrolled</dt>
																<dd className="break-all">
																	{formatTime(device.createdAt)}
																</dd>
															</div>
														</dl>
														<p className="text-xs text-fg-3">
															{device.revoked
																? "Access revoked. Existing company traces are retained."
																: "Enrollment grants collection access; it does not indicate a running collector."}
														</p>
														{!device.revoked &&
															(confirming ? (
																<form
																	className="grid gap-2 border-t border-line pt-3"
																	onSubmit={(event) => {
																		event.preventDefault();
																		setActionTarget(device.id);
																		void action.run(async () => {
																			await api(
																				`/api/devices/${encodeURIComponent(device.id)}`,
																				emptySchema,
																				{ method: "DELETE" },
																			);
																			setConfirming(false);
																			feedback.current?.focus();
																			resource.refresh();
																		}, `Collector ${device.id} revoked. Existing company traces are retained.`);
																	}}
																>
																	<p className="font-medium">
																		Revoke this collector?
																	</p>
																	<p className="text-xs text-fg-2">
																		It will no longer be authorized to send
																		activity. Re-enrollment is required to
																		collect again. Existing company traces are
																		retained.
																	</p>
																	<Feedback
																		action={{
																			...action,
																			success: undefined,
																			error:
																				actionTarget === device.id
																					? action.error
																					: undefined,
																		}}
																	/>
																	<div className="flex flex-wrap gap-2">
																		<Button
																			variant="danger"
																			size="sm"
																			type="submit"
																			disabled={action.pending}
																		>
																			{action.pending
																				? "Revoking…"
																				: "Confirm revoke collector"}
																		</Button>
																		<Button
																			id="collector-revoke-cancel"
																			variant="ghost"
																			size="sm"
																			disabled={action.pending}
																			onClick={() => {
																				setConfirming(false);
																				requestAnimationFrame(() =>
																					document
																						.getElementById("collector-revoke")
																						?.focus(),
																				);
																			}}
																		>
																			Cancel
																		</Button>
																	</div>
																</form>
															) : (
																<div>
																	<Button
																		id="collector-revoke"
																		variant="ghost"
																		size="sm"
																		onClick={() => {
																			setConfirming(true);
																			requestAnimationFrame(() =>
																				document
																					.getElementById(
																						"collector-revoke-cancel",
																					)
																					?.focus(),
																			);
																		}}
																	>
																		Revoke collector
																	</Button>
																</div>
															))}
													</section>
												</td>
											</tr>
										)}
									</Fragment>
								))}
							</tbody>
						</table>
					) : (
						<p className="border-y border-line py-6 text-sm text-fg-3">
							No collectors on this page.
						</p>
					)}
					<fieldset
						disabled={action.pending}
						aria-label="Collector pages"
						className="min-w-0"
					>
						<Pagination
							{...page}
							nextCursor={resource.data.nextCursor}
							previous={() => {
								if (!action.pending) {
									setSelected(undefined);
									setConfirming(false);
									page.previous();
								}
							}}
							next={(cursor) => {
								setSelected(undefined);
								setConfirming(false);
								page.next(cursor);
							}}
						/>
					</fieldset>
				</>
			)}
		</>
	);
}

function CollectorSetup({ onRules }: { onRules: () => void }) {
	const [source, setSource] = useState("claude");
	const origin = window.location.origin;
	return (
		<div className="mb-4 grid gap-3 border-y border-line py-3">
			<div className="flex flex-wrap items-end gap-3">
				<div className="w-40">
					<Field label="Source">
						<Select
							value={source}
							onChange={(event) => setSource(event.target.value)}
						>
							<option value="claude">Claude Code</option>
							<option value="codex">Codex</option>
							<option value="cursor">Cursor</option>
						</Select>
					</Field>
				</div>
				<Button variant="ghost" size="sm" onClick={onRules}>
					Review collection rules
				</Button>
			</div>
			<p className="text-xs text-fg-3">
				Use your company-provided CLI build in an interactive terminal. Review
				authorized scopes before approving collection.
			</p>
			<pre
				className={codeBlockClass}
			>{`trace-vault connect ${source} --vault ${origin}\ntrace-vault collect ${source} --vault ${origin}`}</pre>
			<details>
				<summary className="min-h-7 cursor-pointer text-xs text-fg-2 focus-visible:outline-2 focus-visible:outline-accent">
					Authorization & setup help
				</summary>
				<div className="mt-2 grid gap-2 text-xs text-fg-3">
					<p>
						Confirm the company in the native prompts. Enter passwords and
						invitation tokens only at private prompts; never put tokens, cookies
						or passwords in commands. A public package or global installation is
						not assumed.
					</p>
					<p>
						Connecting approves matching existing history and ongoing
						collection. Collect runs in the foreground; stop with Ctrl-C. No
						startup service is installed. Refresh this list after enrollment.
					</p>
					<p>
						Only approved repositories, exact supported work-account IDs, or
						explicitly approved directories may contribute. For research outside
						a repository, add an approved absolute root with the connect option{" "}
						<code className="font-mono">
							--location /absolute/approved-root
						</code>
						. Unknown historical labels are not verified ownership.
					</p>
					{source === "claude" ? (
						<>
							<p>
								Account capture supports terminal Claude Code 2.1.282 only.
								Repository and location capture do not require account setup. To
								enable metadata-only local OTLP, run account-setup, restart
								Claude, keep collect running, submit a request, then approve the
								observed account and organization:
							</p>
							<pre
								className={codeBlockClass}
							>{`trace-vault account-setup claude --vault ${origin}\ntrace-vault approve-account claude --vault ${origin}`}</pre>
						</>
					) : (
						<p>
							Account capture is unsupported for{" "}
							{source === "codex" ? "Codex" : "Cursor"}; native account labels
							are not contemporaneous identity evidence. Use repository or
							approved location scopes.
						</p>
					)}
					{source === "cursor" && (
						<p>
							Cursor transcripts without per-record workspace evidence require
							an explicitly selected transcript-storage root. Project labels do
							not prove repository ownership.
						</p>
					)}
				</div>
			</details>
		</div>
	);
}
