import { useId, useRef, useState, type ReactNode } from "react";
import { fieldLabelClass } from "../../../src/shared/ui/field";
import {
	Button,
	Icon,
	Input,
	Notice,
	PageHeader,
	ResourceState,
	Section,
	Select,
	api,
	disclosureSummaryClass,
	policySchema,
	useAction,
	useResource,
	type Policy,
} from "./ui-common";

type AccountRow = Policy["accounts"][number] & { key: number };
type LocationRow = { key: number; path: string };

const accountGridClass =
	"grid min-w-0 items-end gap-2 rounded-lg border border-line p-3 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto] md:rounded-none md:border-0 md:p-0";

const emptyListClass =
	"m-0 rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-fg-3";

export function CaptureRules() {
	const resource = useResource("/api/me/capture-rules", policySchema);
	return (
		<>
			<PageHeader
				title="Collection rules"
				description="Which of your work may leave your computers. Any one approved account, repository or directory is enough."
			/>
			<ResourceState
				{...resource}
				retry={resource.refresh}
				label="Loading collection rules"
			/>
			{resource.data && <CaptureForm initial={resource.data} />}
		</>
	);
}

function Disclosure({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<details>
			<summary className={disclosureSummaryClass}>
				<Icon name="chevronRight" size="xs" />
				{title}
			</summary>
			<div className="mt-2 grid max-w-[75ch] gap-2 text-sm text-fg-2">
				{children}
			</div>
		</details>
	);
}

function CaptureForm({ initial }: { initial: Policy }) {
	const id = useId();
	const [policy, setPolicy] = useState(initial);
	const [accounts, setAccounts] = useState<AccountRow[]>(() =>
		initial.accounts.map((account, key) => ({ ...account, key })),
	);
	const [locations, setLocations] = useState<LocationRow[]>(() =>
		initial.locations.map((path, key) => ({ path, key })),
	);
	const nextAccountKey = useRef(initial.accounts.length);
	const nextLocationKey = useRef(initial.locations.length);
	const action = useAction();
	const [edited, setEdited] = useState(false);
	function editAccount(
		key: number,
		change: Partial<Policy["accounts"][number]>,
	) {
		setAccounts((rows) =>
			rows.map((row) => (row.key === key ? { ...row, ...change } : row)),
		);
	}
	return (
		<form
			className="grid min-w-0 text-sm"
			onChange={() => setEdited(true)}
			onSubmit={(event) => {
				event.preventDefault();
				void action.run(async () => {
					const result = await api("/api/me/capture-rules", policySchema, {
						method: "PUT",
						body: {
							accounts: accounts.map(
								({ source, accountId, organizationId }) => ({
									source,
									accountId: accountId.trim(),
									organizationId: organizationId?.trim() || null,
								}),
							),
							locations: [
								...new Set(
									locations.map(({ path }) => path.trim()).filter(Boolean),
								),
							],
						},
					});
					setPolicy(result);
					setAccounts(
						result.accounts.map((account, index) => ({
							...account,
							key: accounts[index]?.key ?? nextAccountKey.current++,
						})),
					);
					setLocations(
						result.locations.map((path) => ({
							path,
							key:
								locations.find((row) => row.path.trim() === path)?.key ??
								nextLocationKey.current++,
						})),
					);
					setEdited(false);
				}, "Collection rules saved.");
			}}
		>
			<fieldset disabled={action.pending} className="grid min-w-0">
				<Section
					id={`${id}-repositories`}
					title="Company repositories"
					description="Approved by your administrators for everyone in the vault."
				>
					{policy.repositories.length ? (
						<ul className="m-0 grid min-w-0 list-none divide-y divide-line-subtle rounded-lg border border-line p-0">
							{policy.repositories.map((repository) => (
								<li
									key={repository}
									className="flex h-9 min-w-0 items-center gap-2 px-3"
								>
									<Icon
										name="repository"
										size="sm"
										className="shrink-0 text-fg-3"
									/>
									<span
										className="truncate font-mono text-xs text-fg-2"
										title={repository}
									>
										{repository}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p className={emptyListClass}>No company repositories approved.</p>
					)}
				</Section>
				<Section
					id={`${id}-accounts`}
					title="Work accounts"
					description="Claude Code account IDs whose new requests may be collected."
					action={
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								const key = nextAccountKey.current++;
								setAccounts((rows) => [
									...rows,
									{
										key,
										source: "claude",
										accountId: "",
										organizationId: null,
									},
								]);
								setEdited(true);
							}}
						>
							<Icon name="plus" size="sm" />
							Add account
						</Button>
					}
				>
					{accounts.length === 0 ? (
						<p className={emptyListClass}>No work accounts approved.</p>
					) : (
						<div className="grid min-w-0 gap-2">
							<div
								aria-hidden="true"
								className="hidden gap-2 text-xs font-medium text-fg-3 md:grid md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
							>
								<span>Provider</span>
								<span>Account ID</span>
								<span>Organization ID (optional)</span>
								<span className="w-8" />
							</div>
							{accounts.map((account, index) => (
								<div key={account.key} className={accountGridClass}>
									<label className={fieldLabelClass + " min-w-0"}>
										<span className="md:sr-only">Provider</span>
										<Select
											value={account.source}
											onChange={(event) =>
												editAccount(account.key, {
													source: event.target.value as AccountRow["source"],
												})
											}
										>
											<option value="claude">Claude</option>
											<option value="codex">Codex</option>
											<option value="cursor">Cursor</option>
										</Select>
									</label>
									<label className={fieldLabelClass + " min-w-0"}>
										<span className="md:sr-only">Account ID</span>
										<Input
											required
											value={account.accountId}
											autoComplete="off"
											spellCheck={false}
											className="font-mono"
											onChange={(event) =>
												editAccount(account.key, {
													accountId: event.target.value,
												})
											}
										/>
									</label>
									<label className={fieldLabelClass + " min-w-0"}>
										<span className="md:sr-only">
											Organization ID (optional)
										</span>
										<Input
											value={account.organizationId ?? ""}
											autoComplete="off"
											spellCheck={false}
											className="font-mono"
											onChange={(event) =>
												editAccount(account.key, {
													organizationId: event.target.value || null,
												})
											}
										/>
									</label>
									<Button
										variant="ghost"
										size="icon"
										className="justify-self-end"
										aria-label={`Remove work account ${index + 1}`}
										title="Remove"
										onClick={() => {
											setAccounts((rows) =>
												rows.filter((row) => row.key !== account.key),
											);
											setEdited(true);
										}}
									>
										<Icon name="trash" size="sm" />
									</Button>
								</div>
							))}
						</div>
					)}
					<Disclosure title="Which accounts are supported">
						<p className="m-0">
							Account capture supports new terminal Claude Code 2.1.282 requests
							only. Run <code className="text-xs">account-setup</code> and{" "}
							<code className="text-xs">approve-account</code> in the collector
							to select an observed account and organization. Adding an ID here
							does not enable telemetry or identify old messages. Codex and
							Cursor need a repository or directory rule instead.
						</p>
						<p className="m-0">
							Use exact provider account IDs from your provider’s account
							information or your company’s collector instructions. Never
							substitute an email domain or guess from historical trace labels,
							and do not enter passwords, API keys or access tokens.
						</p>
					</Disclosure>
				</Section>
				<Section
					id={`${id}-directories`}
					title="Research directories"
					description="Absolute paths for company work outside a repository."
					action={
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								const key = nextLocationKey.current++;
								setLocations((rows) => [...rows, { key, path: "" }]);
								setEdited(true);
							}}
						>
							<Icon name="plus" size="sm" />
							Add directory
						</Button>
					}
				>
					{locations.length === 0 ? (
						<p className={emptyListClass}>No research directories approved.</p>
					) : (
						<div className="grid min-w-0 gap-2">
							{locations.map((location, index) => (
								<div
									key={location.key}
									className="flex min-w-0 items-center gap-2"
								>
									<label className={fieldLabelClass + " min-w-0 flex-1"}>
										<span className="sr-only">
											Absolute directory path {index + 1}
										</span>
										<Input
											icon="folder"
											value={location.path}
											autoComplete="off"
											spellCheck={false}
											placeholder="/home/me/work/company-research"
											onPaste={(event) => {
												const pasted = event.clipboardData.getData("text");
												if (!pasted.includes("\n")) return;
												event.preventDefault();
												const input = event.currentTarget;
												const value =
													location.path.slice(0, input.selectionStart ?? 0) +
													pasted +
													location.path.slice(
														input.selectionEnd ?? location.path.length,
													);
												const replacements = value
													.split(/\r?\n/)
													.map((path, part) => ({
														path,
														key:
															part === 0
																? location.key
																: nextLocationKey.current++,
													}));
												setLocations((rows) =>
													rows.flatMap((row) =>
														row.key === location.key ? replacements : [row],
													),
												);
												setEdited(true);
											}}
											onChange={(event) =>
												setLocations((rows) =>
													rows.map((row) =>
														row.key === location.key
															? { ...row, path: event.target.value }
															: row,
													),
												)
											}
										/>
									</label>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Remove directory ${index + 1}`}
										title="Remove"
										onClick={() => {
											setLocations((rows) =>
												rows.filter((row) => row.key !== location.key),
											);
											setEdited(true);
										}}
									>
										<Icon name="trash" size="sm" />
									</Button>
								</div>
							))}
						</div>
					)}
					<Disclosure title="Choosing directories">
						<p className="m-0">
							Avoid broad home or personal directories. An empty list approves
							no extra locations; company repositories are managed separately.
						</p>
					</Disclosure>
				</Section>
			</fieldset>
			<div className="grid gap-3 border-t border-line pt-5">
				<Disclosure title="Privacy and authorization">
					<p className="m-0">
						An approved work account, company repository or research directory
						can each authorize eligible capture on its own. Personal activity is
						never authorized by an email domain, a historical label or
						inferences from trace content.
					</p>
					<p className="m-0">
						Removing rules changes future capture, not sessions already in the
						vault. Clearing every account and directory removes those approvals;
						company repositories still apply.
					</p>
					<p className="m-0 text-xs text-fg-3">
						Policy revision {policy.revision}
					</p>
				</Disclosure>
				{action.error && (
					<Notice tone="err">
						{action.error} Your edits are kept. Save again to retry.
					</Notice>
				)}
			</div>
			{!edited && !action.pending && !action.error && action.success && (
				<div className="mt-5">
					<Notice tone="ok">{action.success}</Notice>
				</div>
			)}
			{(edited || action.pending || action.error) && (
				<div className="sticky bottom-4 z-10 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas/95 px-4 py-3 shadow-md backdrop-blur-md">
					<p role="status" className="m-0 text-sm text-fg-2">
						{action.pending
							? "Saving; editing is locked."
							: "Unsaved changes. Saving approves the listed accounts and directories."}
					</p>
					<Button variant="primary" type="submit" disabled={action.pending}>
						{action.pending
							? "Saving…"
							: action.error
								? "Retry save"
								: "Save rules"}
					</Button>
				</div>
			)}
		</form>
	);
}
