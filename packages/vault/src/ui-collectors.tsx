import { Fragment, useRef, useState } from "react";
import { z } from "zod";
import { ToolLogo } from "../../../src/shared/ui/tool-logos";
import {
	Button,
	CopyCommand,
	EmptyState,
	Feedback,
	Icon,
	PageHeader,
	Pagination,
	Person,
	ResourceState,
	SourceMark,
	StatusText,
	api,
	codeBlockClass,
	disclosureSummaryClass,
	emptySchema,
	formatDay,
	formatTime,
	pageSchema,
	segmentedGroupClass,
	segmentedItemClasses,
	tableBodyClass,
	tableClasses,
	tableDenseCellClass,
	tableFrameClass,
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
		memberName: z.string(),
		createdAt: z.string(),
		revoked: z.boolean(),
	}),
);
type Device = z.infer<typeof devicesSchema>["items"][number];

const sources = [
	{ value: "claude", label: "Claude Code" },
	{ value: "codex", label: "Codex" },
	{ value: "cursor", label: "Cursor" },
] as const;

export function Collectors({ onRules }: { onRules: () => void }) {
	const page = usePage();
	const resource = useResource(`/api/devices${page.query}`, devicesSchema);
	const action = useAction();
	const [setup, setSetup] = useState<boolean | null>(null);
	const [confirming, setConfirming] = useState<string>();
	const [actionTarget, setActionTarget] = useState<string>();
	const feedback = useRef<HTMLDivElement>(null);
	const empty =
		page.page === 1 &&
		resource.data?.items.length === 0 &&
		!resource.data.nextCursor;
	const setupOpen = setup ?? empty;
	return (
		<>
			<PageHeader
				title="Collectors"
				description="Computers enrolled to send approved sessions to this vault"
			>
				<Button
					variant="secondary"
					disabled={resource.loading || action.pending}
					onClick={resource.refresh}
				>
					Refresh
				</Button>
				<Button
					variant={setupOpen ? "secondary" : "primary"}
					aria-expanded={!!setupOpen}
					aria-controls="collector-setup"
					onClick={() => setSetup(!setupOpen)}
				>
					<Icon name={setupOpen ? "close" : "plus"} size="sm" />
					{setupOpen ? "Close setup" : "Enroll a collector"}
				</Button>
			</PageHeader>
			<section id="collector-setup" hidden={!setupOpen}>
				{setupOpen && <CollectorSetup onRules={onRules} />}
			</section>
			<div ref={feedback} tabIndex={-1} className="mb-3 grid gap-2 empty:mb-0">
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
			<ResourceState
				{...resource}
				retry={resource.refresh}
				label="Loading collectors"
			/>
			{resource.data && (
				<>
					{resource.data.items.length ? (
						<div className={tableFrameClass}>
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
												tableHeaderCellClass + " hidden w-36 md:table-cell"
											}
										>
											Source
										</th>
										<th
											scope="col"
											className={
												tableHeaderCellClass + " hidden w-44 lg:table-cell"
											}
										>
											Owner
										</th>
										<th
											scope="col"
											className={
												tableHeaderCellClass + " hidden w-32 sm:table-cell"
											}
										>
											Enrolled
										</th>
										<th scope="col" className={tableHeaderCellClass + " w-28"}>
											Access
										</th>
										<th scope="col" className={tableHeaderCellClass + " w-24"}>
											<span className="sr-only">Actions</span>
										</th>
									</tr>
								</thead>
								<tbody className={tableBodyClass}>
									{resource.data.items.map((device) => (
										<Fragment key={device.id}>
											<DeviceRow
												device={device}
												confirming={confirming === device.id}
												disabled={action.pending}
												onRevoke={() =>
													setConfirming(
														confirming === device.id ? undefined : device.id,
													)
												}
											/>
											{confirming === device.id && (
												<tr>
													<td colSpan={6} className="p-0">
														<form
															id={`revoke-${device.id}`}
															className="grid gap-2 border-t border-err/20 bg-err/5 px-4 py-3"
															onSubmit={(event) => {
																event.preventDefault();
																setActionTarget(device.id);
																void action.run(
																	async () => {
																		await api(
																			`/api/devices/${encodeURIComponent(device.id)}`,
																			emptySchema,
																			{ method: "DELETE" },
																		);
																		setConfirming(undefined);
																		feedback.current?.focus();
																		resource.refresh();
																	},
																	`${device.name || "Collector"} revoked. Its sessions stay in the vault.`,
																);
															}}
														>
															<p className="m-0 text-sm font-medium">
																Revoke {device.name || "this collector"}?
															</p>
															<p className="m-0 max-w-[70ch] text-sm text-fg-2">
																It can no longer send activity; collecting again
																needs a new enrollment. Sessions it already sent
																stay in the vault.
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
																	autoFocus
																>
																	{action.pending
																		? "Revoking…"
																		: "Revoke collector"}
																</Button>
																<Button
																	variant="ghost"
																	size="sm"
																	disabled={action.pending}
																	onClick={() => setConfirming(undefined)}
																>
																	Cancel
																</Button>
															</div>
														</form>
													</td>
												</tr>
											)}
										</Fragment>
									))}
								</tbody>
							</table>
						</div>
					) : (
						!setupOpen && (
							<EmptyState title="No collectors on this page">
								Return to the previous page or refresh the list.
							</EmptyState>
						)
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
								setConfirming(undefined);
								page.previous();
							}}
							next={(cursor) => {
								setConfirming(undefined);
								page.next(cursor);
							}}
						/>
					</fieldset>
				</>
			)}
			{!!resource.data?.items.length && (
				<p className="mt-4 text-xs text-fg-3">
					Enrollment grants permission to send activity; it does not show
					whether a collector is running.
				</p>
			)}
		</>
	);
}

function DeviceRow({
	device,
	confirming,
	disabled,
	onRevoke,
}: {
	device: Device;
	confirming: boolean;
	disabled: boolean;
	onRevoke: () => void;
}) {
	return (
		<tr className={confirming ? "bg-hover" : "hover:bg-hover"}>
			<td className={tableDenseCellClass + " h-12"}>
				<div className="min-w-0">
					<p
						className="m-0 truncate font-medium text-fg"
						title={device.name || "Unnamed collector"}
					>
						{device.name || "Unnamed collector"}
					</p>
					<p
						className="m-0 truncate font-mono text-2xs text-fg-3"
						title={`Collector ID ${device.id}`}
					>
						{device.id.slice(0, 8)}
						<span className="font-sans md:hidden">
							{" · "}
							<SourceMark source={device.source} />
						</span>
					</p>
				</div>
			</td>
			<td className={tableDenseCellClass + " hidden text-fg-2 md:table-cell"}>
				<SourceMark source={device.source} />
			</td>
			<td className={tableDenseCellClass + " hidden lg:table-cell"}>
				<span title={`Member ID ${device.memberId}`}>
					<Person name={device.memberName} />
				</span>
			</td>
			<td className={tableDenseCellClass + " hidden text-fg-3 sm:table-cell"}>
				<time dateTime={device.createdAt} title={formatTime(device.createdAt)}>
					{formatDay(device.createdAt)}
				</time>
			</td>
			<td className={tableDenseCellClass}>
				<StatusText tone={device.revoked ? "neutral" : "ok"}>
					{device.revoked ? "Revoked" : "Enrolled"}
				</StatusText>
			</td>
			<td className={tableDenseCellClass + " text-right"}>
				{!device.revoked && (
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled}
						aria-expanded={confirming}
						aria-controls={confirming ? `revoke-${device.id}` : undefined}
						aria-label={`Revoke ${device.name || "unnamed collector"} (${device.id})`}
						onClick={onRevoke}
					>
						Revoke
					</Button>
				)}
			</td>
		</tr>
	);
}

function CollectorSetup({ onRules }: { onRules: () => void }) {
	const [source, setSource] =
		useState<(typeof sources)[number]["value"]>("claude");
	const origin = window.location.origin;
	return (
		<div className="mb-6 grid gap-5 rounded-lg border border-line bg-raised p-5 shadow-sm">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="m-0 text-base font-semibold">Connect a computer</h2>
					<p className="mt-1 mb-0 max-w-[70ch] text-sm text-fg-3">
						Run these in an interactive terminal on the machine that holds the
						sessions. You confirm the vault and enter your password in private
						prompts; never paste tokens or passwords into commands.
					</p>
				</div>
				<div
					role="radiogroup"
					aria-label="Agent"
					className={segmentedGroupClass}
				>
					{sources.map((option) => (
						<button
							key={option.value}
							type="button"
							role="radio"
							aria-checked={source === option.value}
							className={
								(source === option.value
									? segmentedItemClasses.selected
									: segmentedItemClasses.idle) + " gap-1.5"
							}
							onClick={() => setSource(option.value)}
						>
							<ToolLogo name={option.value} className="size-3.5" />
							{option.label}
						</button>
					))}
				</div>
			</div>
			<div className="grid gap-4">
				<CopyCommand
					label="Approve this computer and its matching history"
					command={`trace-vault connect ${source} --vault ${origin}`}
				/>
				<CopyCommand
					label="Keep collecting in the foreground (stop with Ctrl-C)"
					command={`trace-vault collect ${source} --vault ${origin}`}
				/>
			</div>
			<p className="m-0 text-xs text-fg-3">
				Only work matching your{" "}
				<button
					type="button"
					className="rounded-sm text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					onClick={onRules}
				>
					collection rules
				</button>{" "}
				leaves the machine: an approved repository, work account or research
				directory. Refresh this list after enrolling.
			</p>
			<details>
				<summary className={disclosureSummaryClass}>
					<Icon name="chevronRight" size="xs" />
					Installation, accounts and other directories
				</summary>
				<div className="mt-3 grid max-w-[75ch] gap-2 text-sm text-fg-2">
					<p className="m-0">
						Use the collector build your company provides; a public package or
						global installation is not assumed. Collect runs until you stop it
						and installs no startup service.
					</p>
					<p className="m-0">
						For research outside a repository, approve an absolute directory
						with{" "}
						<code className="font-mono text-xs">
							--location /absolute/approved-root
						</code>{" "}
						when connecting. Historical labels are not verified ownership.
					</p>
					{source === "claude" ? (
						<>
							<p className="m-0">
								Account capture supports terminal Claude Code 2.1.282 only and
								is not needed for repository or directory collection. To enable
								metadata-only local OTLP, run account-setup, restart Claude,
								keep collect running, send a request, then approve the observed
								account and organization:
							</p>
							<pre
								className={codeBlockClass}
							>{`trace-vault account-setup claude --vault ${origin}\ntrace-vault approve-account claude --vault ${origin}`}</pre>
						</>
					) : (
						<p className="m-0">
							Account capture is not supported for{" "}
							{source === "codex" ? "Codex" : "Cursor"}; its account labels are
							not contemporaneous identity evidence. Use repository or directory
							rules.
						</p>
					)}
					{source === "cursor" && (
						<p className="m-0">
							Cursor transcripts without per-record workspace evidence need an
							explicitly selected transcript-storage root. Project labels do not
							prove repository ownership.
						</p>
					)}
				</div>
			</details>
		</div>
	);
}
