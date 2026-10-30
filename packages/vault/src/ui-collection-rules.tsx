import { useId, useRef, useState } from "react";
import { fieldLabelClass } from "../../../src/shared/ui/field";
import {
	Button,
	Heading,
	Input,
	Notice,
	ResourceState,
	Select,
	api,
	policySchema,
	useAction,
	useResource,
	type Policy,
} from "./ui-common";

type AccountRow = Policy["accounts"][number] & { key: number };
type LocationRow = { key: number; path: string };

const accountGridClass =
	"grid min-w-0 grid-cols-2 items-end gap-2 md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_4rem]";
const disclosureClass =
	"min-h-7 cursor-pointer py-1 text-sm text-fg-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function CaptureRules() {
	const resource = useResource("/api/me/capture-rules", policySchema);
	return (
		<>
			<Heading
				title="Collection rules"
				description="Authorize work by account, repository or directory."
			/>
			<ResourceState {...resource} retry={resource.refresh} />
			{resource.data && <CaptureForm initial={resource.data} />}
		</>
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
				<section
					aria-labelledby={`${id}-accounts`}
					className="grid min-w-0 gap-2 border-t border-line py-3"
				>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 id={`${id}-accounts`} className="text-sm font-semibold">
							Work accounts
						</h2>
						<Button
							variant="ghost"
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
							Add account
						</Button>
					</div>
					{accounts.length === 0 ? (
						<p className="text-fg-3">No work accounts authorized.</p>
					) : (
						<div className="grid min-w-0 gap-1">
							<div
								aria-hidden="true"
								className="hidden gap-2 text-xs text-fg-3 md:grid md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_4rem]"
							>
								<span>Provider</span>
								<span>Account ID</span>
								<span>Organization ID · optional</span>
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
											onChange={(event) =>
												editAccount(account.key, {
													accountId: event.target.value,
												})
											}
										/>
									</label>
									<label className={fieldLabelClass + " min-w-0"}>
										<span className="md:sr-only">
											Organization ID · optional
										</span>
										<Input
											value={account.organizationId ?? ""}
											autoComplete="off"
											spellCheck={false}
											onChange={(event) =>
												editAccount(account.key, {
													organizationId: event.target.value || null,
												})
											}
										/>
									</label>
									<Button
										variant="ghost"
										size="sm"
										className="justify-self-end"
										aria-label={`Remove work account ${index + 1}`}
										onClick={() => {
											setAccounts((rows) =>
												rows.filter((row) => row.key !== account.key),
											);
											setEdited(true);
										}}
									>
										Remove
									</Button>
								</div>
							))}
						</div>
					)}
					<details>
						<summary className={disclosureClass}>
							Account support & setup
						</summary>
						<div className="grid gap-2 pt-1 text-fg-2">
							<p>
								Account capture supports new terminal Claude Code 2.1.282
								requests only. Run <code>account-setup</code> and{" "}
								<code>approve-account</code> in the collector to select an
								observed account and organization. Adding an ID here does not
								enable telemetry or identify old messages. Codex and Cursor need
								a repository or directory rule instead.
							</p>
							<p>
								Use exact provider account IDs from your provider’s account
								information or company collector instructions. Organization ID
								is optional unless your provider requires it. Ask an
								administrator if unsure; never substitute an email domain or
								guess from historical trace labels. Do not enter passwords, API
								keys or access tokens.
							</p>
						</div>
					</details>
				</section>
				<section
					aria-labelledby={`${id}-directories`}
					className="grid min-w-0 gap-2 border-t border-line py-3"
				>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<h2 id={`${id}-directories`} className="text-sm font-semibold">
							Research directories
						</h2>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								const key = nextLocationKey.current++;
								setLocations((rows) => [...rows, { key, path: "" }]);
								setEdited(true);
							}}
						>
							Add directory
						</Button>
					</div>
					{locations.length === 0 ? (
						<p className="text-fg-3">No extra research locations authorized.</p>
					) : (
						<div className="grid min-w-0 gap-1">
							<p className="text-xs text-fg-3">Absolute directory path</p>
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
										size="sm"
										aria-label={`Remove directory ${index + 1}`}
										onClick={() => {
											setLocations((rows) =>
												rows.filter((row) => row.key !== location.key),
											);
											setEdited(true);
										}}
									>
										Remove
									</Button>
								</div>
							))}
						</div>
					)}
					<details>
						<summary className={disclosureClass}>Directory scope</summary>
						<p className="pt-1 text-fg-2">
							Approve absolute paths for company research outside repositories.
							Avoid broad home or personal directories. An empty list approves
							no extra locations; company repository access is managed
							separately.
						</p>
					</details>
				</section>
			</fieldset>
			<section
				aria-labelledby={`${id}-repositories`}
				className="grid min-w-0 gap-2 border-t border-line py-3"
			>
				<div className="flex flex-wrap items-center gap-2">
					<h2 id={`${id}-repositories`} className="text-sm font-semibold">
						Company repositories
					</h2>
					<span className="text-xs text-fg-3">Managed by your company</span>
				</div>
				{policy.repositories.length ? (
					<ul className="grid min-w-0 divide-y divide-line-subtle">
						{policy.repositories.map((repository) => (
							<li
								key={repository}
								className="min-w-0 py-1 break-all font-mono text-sm text-fg-2"
							>
								{repository}
							</li>
						))}
					</ul>
				) : (
					<p className="text-fg-3">No company repositories approved.</p>
				)}
			</section>
			<div className="grid gap-2 border-t border-line pt-3">
				<p className="text-fg-2">
					Saving authorizes the listed accounts and directories for company
					collection.
				</p>
				<details>
					<summary className={disclosureClass}>Privacy & authorization</summary>
					<div className="grid gap-2 pt-1 text-fg-2">
						<p>
							An approved work account, company repository or research directory
							can independently authorize eligible capture; they are
							alternatives, not combined requirements. Personal activity is not
							authorized by an email domain, a historical label or inferences
							from trace content.
						</p>
						<p>
							Removing rules changes future capture, not retained company trace
							history. Clearing all accounts and directories removes those
							approvals; company repository rules still apply.
						</p>
						<p className="text-xs text-fg-3">
							Policy revision {policy.revision}
						</p>
					</div>
				</details>
				{action.error && (
					<Notice tone="err">
						{action.error} Your edits are kept. Save again to retry.
					</Notice>
				)}
				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={action.pending}
					>
						{action.pending
							? "Saving…"
							: action.error
								? "Retry save"
								: "Save rules"}
					</Button>
					<p role="status" className="text-xs text-fg-3">
						{action.pending
							? "Saving; editing is temporarily locked."
							: edited
								? "Unsaved changes"
								: action.success}
					</p>
				</div>
			</div>
		</form>
	);
}
