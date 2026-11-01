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
	HarnessLogo,
	StatusText,
	api,
	codeBlockClass,
	disclosureSummaryClass,
	emptySchema,
	formatDay,
	formatTime,
	pageSchema,
	segmentedGroupClass,
	sourceLabel,
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
	const [selected, setSelected] = useState<string>();
	const [confirming, setConfirming] = useState(false);
	const [actionTarget, setActionTarget] = useState<string>();
	const feedback = useRef<HTMLDivElement>(null);
	const empty =
		page.page === 1 &&
		resource.data?.items.length === 0 &&
		!resource.data.nextCursor;
	const setupOpen = setup ?? empty;
	function leavePage() {
		setSelected(undefined);
		setConfirming(false);
	}
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
												tableHeaderCellClass + " hidden w-24 md:table-cell"
											}
										>
											Harness
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
									</tr>
								</thead>
								<tbody className={tableBodyClass}>
									{resource.data.items.map((device) => (
										<Fragment key={device.id}>
											<DeviceRow
												device={device}
												open={selected === device.id}
												disabled={action.pending}
												onToggle={() => {
													setSelected(
														selected === device.id ? undefined : device.id,
													);
													setConfirming(false);
												}}
											/>
											{selected === device.id && (
												<tr className="bg-surface">
													<td colSpan={5} className="px-4 py-3 sm:pl-10">
														<DeviceDetails
															device={device}
															confirming={confirming}
															action={action}
															actionTarget={actionTarget}
															onConfirm={setConfirming}
															onRevoke={() => {
																setActionTarget(device.id);
																void action.run(
																	async () => {
																		await api(
																			`/api/devices/${encodeURIComponent(device.id)}`,
																			emptySchema,
																			{ method: "DELETE" },
																		);
																		setConfirming(false);
																		feedback.current?.focus();
																		resource.refresh();
																	},
																	`${device.name || "Collector"} revoked. Its sessions stay in the vault.`,
																);
															}}
														/>
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
								leavePage();
								page.previous();
							}}
							next={(cursor) => {
								leavePage();
								page.next(cursor);
							}}
						/>
					</fieldset>
				</>
			)}
		</>
	);
}

function DeviceRow({
	device,
	open,
	disabled,
	onToggle,
}: {
	device: Device;
	open: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	const name = device.name || "Unnamed collector";
	return (
		<tr className={open ? "bg-hover" : "hover:bg-hover"}>
			<td className="h-11 min-w-0 px-1.5 py-0 align-middle">
				<Button
					variant="ghost"
					className="w-full min-w-0 justify-start text-left hover:bg-transparent"
					disabled={disabled}
					aria-expanded={open}
					aria-controls={open ? `collector-${device.id}` : undefined}
					aria-label={`Details for ${name}, owned by ${device.memberName || "an unnamed member"}`}
					onClick={onToggle}
				>
					<Icon
						name="chevronRight"
						size="xs"
						className={
							open
								? "rotate-90 text-fg-3 transition-transform"
								: "text-fg-4 transition-transform"
						}
					/>
					<span className="truncate font-medium text-fg" title={name}>
						{name}
					</span>
				</Button>
			</td>
			<td className={tableDenseCellClass + " hidden md:table-cell"}>
				<HarnessLogo source={device.source} />
			</td>
			<td className={tableDenseCellClass + " hidden lg:table-cell"}>
				<Person name={device.memberName} />
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
		</tr>
	);
}

function DeviceDetails({
	device,
	confirming,
	action,
	actionTarget,
	onConfirm,
	onRevoke,
}: {
	device: Device;
	confirming: boolean;
	action: ReturnType<typeof useAction>;
	actionTarget?: string;
	onConfirm: (confirming: boolean) => void;
	onRevoke: () => void;
}) {
	const revoke = `collector-revoke-${device.id}`;
	const cancel = `collector-revoke-cancel-${device.id}`;
	return (
		<section
			id={`collector-${device.id}`}
			aria-label="Collector details"
			className="grid gap-3 text-sm"
		>
			<dl className="m-0 grid min-w-0 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
				<dt className="text-fg-3">Collector ID</dt>
				<dd className="m-0 min-w-0 font-mono break-all text-fg-2">
					{device.id}
				</dd>
				<dt className="text-fg-3">Owner</dt>
				<dd className="m-0 min-w-0 break-all text-fg-2">
					{device.memberName || "Unnamed member"}
					<span className="mt-0.5 block font-mono text-fg-3">
						{device.memberId}
					</span>
				</dd>
				<dt className="text-fg-3">Harness</dt>
				<dd className="m-0 min-w-0 text-fg-2">{sourceLabel(device.source)}</dd>
				<dt className="text-fg-3">Enrolled</dt>
				<dd className="m-0 min-w-0 text-fg-2">
					{formatTime(device.createdAt)}
				</dd>
			</dl>
			<p className="m-0 text-xs text-fg-3">
				{device.revoked
					? "Access revoked. Existing company traces are retained."
					: "Enrollment grants permission to send activity; it does not show whether a collector is running."}
			</p>
			{!device.revoked &&
				(confirming ? (
					<form
						className="grid gap-2 rounded-lg border border-err/30 bg-err/5 p-3"
						onSubmit={(event) => {
							event.preventDefault();
							onRevoke();
						}}
					>
						<p className="m-0 font-medium">Revoke this collector?</p>
						<p className="m-0 max-w-[70ch] text-fg-2">
							It can no longer send activity; collecting again needs a new
							enrollment. Sessions it already sent stay in the vault.
						</p>
						<Feedback
							action={{
								...action,
								success: undefined,
								error: actionTarget === device.id ? action.error : undefined,
							}}
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="danger"
								size="sm"
								type="submit"
								disabled={action.pending}
							>
								{action.pending ? "Revoking…" : "Confirm revoke collector"}
							</Button>
							<Button
								id={cancel}
								variant="ghost"
								size="sm"
								disabled={action.pending}
								onClick={() => {
									onConfirm(false);
									requestAnimationFrame(() =>
										document.getElementById(revoke)?.focus(),
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
							id={revoke}
							variant="danger"
							size="sm"
							onClick={() => {
								onConfirm(true);
								requestAnimationFrame(() =>
									document.getElementById(cancel)?.focus(),
								);
							}}
						>
							Revoke collector
						</Button>
					</div>
				))}
		</section>
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
