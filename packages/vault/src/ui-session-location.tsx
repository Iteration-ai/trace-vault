import { Icon } from "./ui-common";

export function SessionLocation({
	repository,
	cwd,
}: {
	repository: string | null;
	cwd: string | null;
}) {
	const value = repository || cwd;
	if (!value) return <span className="text-fg-3">—</span>;
	const separator = repository || !value.includes("\\") ? "/" : "\\";
	const label = repository
		? value.replace(/^github\.com\//, "")
		: value.replace(/[\\/]+$/, "") || value;
	const split = label.lastIndexOf(separator);
	const name = label.slice(split + 1) || label;
	let context = split > 0 ? label.slice(0, split) : "";
	if (!repository) {
		const folders = context.split(separator);
		if (folders.length > 2) context = folders.at(-1)!;
	}
	return (
		<span className="flex min-w-0 items-center gap-1.5 text-xs" title={value}>
			<span className="sr-only">
				{repository ? "Repository" : "Directory"}: {value}
			</span>
			<span aria-hidden="true" className="shrink-0 text-fg-3">
				<Icon name={repository ? "repository" : "folder"} size="xs" />
			</span>
			<span aria-hidden="true" className="flex min-w-0">
				{context && <span className="truncate text-fg-3">{context}</span>}
				<span className="max-w-full shrink-0 truncate text-fg-2">
					{split >= 0 && name !== separator ? separator : ""}
					{name}
				</span>
			</span>
		</span>
	);
}
