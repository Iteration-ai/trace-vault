import { useEffect, useRef, useState } from "react";
import {
	Button,
	Heading,
	Icon,
	Input,
	Notice,
	ResourceState,
	api,
	policySchema,
	useAction,
	useResource,
	type Policy,
} from "./ui-common";

export function RepositoryPolicy() {
	const resource = useResource("/api/me/capture-rules", policySchema);
	return (
		<>
			<Heading
				title="Repository access"
				description="Company repositories approved for collection."
			/>
			<ResourceState {...resource} retry={resource.refresh} />
			{resource.data && <RepositoryForm initial={resource.data} />}
		</>
	);
}

function RepositoryForm({ initial }: { initial: Policy }) {
	const [policy, setPolicy] = useState(initial);
	const [editing, setEditing] = useState(false);
	const [saved, setSaved] = useState(false);
	const section = useRef<HTMLElement>(null);
	function closeEditor() {
		setEditing(false);
		requestAnimationFrame(() =>
			section.current
				?.querySelector<HTMLButtonElement>("[data-manage-repositories]")
				?.focus(),
		);
	}
	return (
		<section
			ref={section}
			className="min-w-0 text-sm"
			aria-label="Approved repositories"
		>
			<div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line pb-2">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
					<h2 className="text-sm font-medium">
						{editing ? "Manage repositories" : "Approved repositories"}
					</h2>
					<span className="min-w-0 text-xs break-all text-fg-3">
						Revision {policy.revision}
					</span>
				</div>
				{!editing && (
					<Button
						data-manage-repositories
						variant="secondary"
						size="sm"
						onClick={() => {
							setSaved(false);
							setEditing(true);
						}}
					>
						Manage
					</Button>
				)}
			</div>
			{editing ? (
				<RepositoryEditor
					initial={policy}
					onCancel={closeEditor}
					onSaved={(result) => {
						setPolicy(result);
						setSaved(true);
						closeEditor();
					}}
				/>
			) : policy.repositories.length ? (
				<ul className="min-w-0 divide-y divide-line-subtle">
					{policy.repositories.map((repository) => (
						<li
							key={repository}
							className="flex h-8 min-w-0 items-center gap-2"
						>
							<span className="shrink-0 text-fg-3" aria-hidden="true">
								<Icon name="repository" size="sm" />
							</span>
							<span className="truncate font-mono text-fg-2" title={repository}>
								{repository}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="py-3 text-fg-3">No repositories approved.</p>
			)}
			{saved && (
				<p className="mt-2 text-xs text-ok" role="status">
					Repository access saved. Approved keys and revision updated above.
				</p>
			)}
			<details className="mt-4 text-xs text-fg-3">
				<summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
					Repository access help
				</summary>
				<div className="mt-2 grid max-w-2xl gap-2 text-sm text-fg-2">
					<p>
						Only authorize repositories the company owns or has permission to
						collect. Never include passwords or tokens in URLs.
					</p>
					<p>
						HTTPS, SSH and scp-style URLs are accepted, including nested paths
						and custom hosts. The server returns canonical repository keys after
						saving.
					</p>
					<p>
						Collection requires an approved work account or an approved company
						repository or research location—not all three. Removing a repository
						changes future collection, not existing history. Other approvals
						remain in effect.
					</p>
				</div>
			</details>
		</section>
	);
}

function RepositoryEditor({
	initial,
	onSaved,
	onCancel,
}: {
	initial: Policy;
	onSaved: (policy: Policy) => void;
	onCancel: () => void;
}) {
	const [rows, setRows] = useState(() =>
		initial.repositories.map((repository, key) => ({
			key,
			value: `https://${repository}`,
		})),
	);
	const nextKey = useRef(initial.repositories.length);
	const action = useAction();
	const form = useRef<HTMLFormElement>(null);
	useEffect(() => {
		form.current?.querySelector<HTMLElement>("input, button")?.focus();
	}, []);
	return (
		<form
			ref={form}
			className="grid min-w-0 gap-3 pt-3"
			onSubmit={(event) => {
				event.preventDefault();
				void action.run(async () => {
					const result = await api("/api/settings/policy", policySchema, {
						method: "PUT",
						body: {
							repositories: rows.map((row) => row.value.trim()).filter(Boolean),
						},
					});
					onSaved(result);
				});
			}}
		>
			<p className="text-xs text-fg-3">
				Removal takes effect on save. Existing history stays.
			</p>
			<fieldset disabled={action.pending} className="grid min-w-0 gap-1">
				<legend className="mb-1 text-xs font-medium text-fg-2">
					HTTPS or SSH repository URLs
				</legend>
				<div className="grid max-h-80 min-w-0 gap-1 overflow-y-auto">
					{rows.map((row, index) => (
						<div key={row.key} className="flex min-w-0 items-center gap-1">
							<Input
								aria-label={`Repository URL ${index + 1}`}
								data-repository-row={row.key}
								className="flex-1"
								value={row.value}
								autoComplete="off"
								spellCheck={false}
								placeholder="https://github.com/company/project.git"
								onChange={(event) => {
									const value = event.target.value;
									setRows((current) =>
										current.map((item) =>
											item.key === row.key ? { ...item, value } : item,
										),
									);
								}}
								onPaste={(event) => {
									const pasted = event.clipboardData.getData("text");
									if (!/[\r\n]/.test(pasted)) return;
									event.preventDefault();
									const input = event.currentTarget;
									const value =
										row.value.slice(0, input.selectionStart ?? 0) +
										pasted +
										row.value.slice(input.selectionEnd ?? row.value.length);
									const values = value
										.split(/\r\n|\r|\n/)
										.filter((line) => line.trim());
									const replacements = values.map((value, position) => ({
										key: position === 0 ? row.key : nextKey.current++,
										value,
									}));
									setRows((current) =>
										current.flatMap((item) =>
											item.key === row.key ? replacements : [item],
										),
									);
								}}
							/>
							<Button
								variant="ghost"
								size="sm"
								aria-label={`Remove repository URL ${index + 1}`}
								onClick={() => {
									setRows((current) =>
										current.filter((item) => item.key !== row.key),
									);
									requestAnimationFrame(() => {
										const inputs =
											form.current?.querySelectorAll<HTMLInputElement>("input");
										const target = inputs?.[Math.min(index, inputs.length - 1)];
										(
											target ??
											form.current?.querySelector<HTMLButtonElement>(
												"[data-add-url]",
											)
										)?.focus();
									});
								}}
							>
								Remove
							</Button>
						</div>
					))}
				</div>
				<div className="mt-1">
					<Button
						data-add-url
						variant="ghost"
						size="sm"
						onClick={() => {
							const key = nextKey.current++;
							setRows((current) => [...current, { key, value: "" }]);
							requestAnimationFrame(() =>
								form.current
									?.querySelector<HTMLInputElement>(
										`[data-repository-row="${key}"]`,
									)
									?.focus(),
							);
						}}
					>
						<Icon name="plus" size="sm" />
						Add URL
					</Button>
				</div>
			</fieldset>
			<p className="text-xs text-fg-3">
				Paste multiple URLs, one per line, into any field. No credentials.
			</p>
			<p className="text-xs text-fg-2">
				Save only company-authorized repositories. Removing entries affects
				future collection, not existing history.
				{rows.every((row) => !row.value.trim()) &&
					" An empty list approves no repositories."}
			</p>
			{action.error && <Notice tone="err">{action.error}</Notice>}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="primary"
					size="sm"
					type="submit"
					disabled={action.pending}
				>
					{action.pending ? "Saving…" : "Save access"}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={action.pending}
					onClick={onCancel}
				>
					Cancel
				</Button>
				{action.pending && (
					<span className="text-xs text-fg-3" role="status">
						Saving repository access. Editing is locked.
					</span>
				)}
			</div>
		</form>
	);
}
