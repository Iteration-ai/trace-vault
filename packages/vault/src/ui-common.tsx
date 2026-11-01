import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { collectorSourceLabel } from "iteration-trace-contracts";
import { z } from "zod";
import { Button } from "../../../src/shared/ui/button";
import { Input, fieldLabelClass } from "../../../src/shared/ui/field";
import { Icon } from "../../../src/shared/ui/icon";
import { Notice } from "../../../src/shared/ui/notice";
import { popoverClasses } from "../../../src/shared/ui/panel";
import { ToolLogo } from "../../../src/shared/ui/tool-logos";

export { Button, buttonClasses } from "../../../src/shared/ui/button";
export { Input, Select } from "../../../src/shared/ui/field";
export { Notice } from "../../../src/shared/ui/notice";
export {
	Panel,
	codeBlockClass,
	popoverClasses,
} from "../../../src/shared/ui/panel";
export { Icon } from "../../../src/shared/ui/icon";
export { Badge, StatusText } from "../../../src/shared/ui/badge";
export {
	segmentedGroupClass,
	segmentedItemClasses,
} from "../../../src/shared/ui/segmented";
export {
	tableBodyClass,
	tableClasses,
	tableDenseCellClass,
	tableHeaderCellClass,
	tableHeadRowClass,
} from "../../../src/shared/ui/table";

export const memberSchema = z.object({
	id: z.string(),
	email: z.string(),
	name: z.string(),
	role: z.enum(["admin", "member"]),
});
export type Member = z.infer<typeof memberSchema>;
export const meSchema = z.object({
	member: memberSchema,
	vaultName: z.string(),
});
const accountSchema = z.object({
	source: z.enum(["claude", "codex", "cursor"]),
	accountId: z.string(),
	organizationId: z.string().nullable(),
});
export const policySchema = z.object({
	revision: z.union([z.string(), z.number()]),
	repositories: z.array(z.string()),
	accounts: z.array(accountSchema),
	locations: z.array(z.string()),
});
export type Policy = z.infer<typeof policySchema>;
export const emptySchema = z.void();
export const SESSION_EXPIRED_EVENT = "vault-session-expired";

// Record collections share one bordered surface, like the product's tables.
export const tableFrameClass =
	"min-w-0 overflow-hidden rounded-lg border border-line bg-canvas";

export const disclosureSummaryClass =
	"flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs font-medium text-fg-3 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden";

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const errorSchema = z.object({
	error: z.string().optional(),
	message: z.string().optional(),
});

async function responseError(
	response: Response,
	path: string,
): Promise<ApiError> {
	if (
		response.status === 401 &&
		path !== "/api/me" &&
		!path.startsWith("/api/auth/")
	)
		window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
	let detail = "";
	if (response.headers.get("content-type")?.includes("application/json")) {
		const parsed = errorSchema.safeParse(await response.json());
		if (parsed.success) detail = parsed.data.message ?? parsed.data.error ?? "";
	}
	const guidance =
		response.status === 403
			? "You do not have permission for this action."
			: response.status === 401
				? "Sign in again to continue."
				: "The request failed. Please try again.";
	return new ApiError(
		response.status,
		`${detail.slice(0, 600) || guidance} (HTTP ${response.status})`,
	);
}

export async function api<T>(
	path: string,
	schema: z.ZodType<T>,
	options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
	const response = await fetch(path, {
		method: options.method ?? "GET",
		credentials: "same-origin",
		cache: "no-store",
		signal: options.signal,
		headers: {
			Accept: "application/json",
			...(options.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		...(options.body === undefined
			? {}
			: { body: JSON.stringify(options.body) }),
	});
	if (!response.ok) throw await responseError(response, path);
	const value: unknown =
		response.status === 204 ? undefined : await response.json();
	const parsed = schema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			"The vault returned an unexpected response. Refresh the page or contact your administrator.",
		);
	return parsed.data;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "Something went wrong. Please try again.";
}

export function useResource<T>(path: string, schema: z.ZodType<T>) {
	const [result, setResult] = useState<{
		key: string;
		data?: T;
		error?: string;
	}>({ key: "" });
	const [version, setVersion] = useState(0);
	const requestKey = `${path}:${version}`;
	useEffect(() => {
		const controller = new AbortController();
		api(path, schema, { signal: controller.signal }).then(
			(data) => {
				if (!controller.signal.aborted) setResult({ key: requestKey, data });
			},
			(error) => {
				if (!controller.signal.aborted)
					setResult({ key: requestKey, error: errorMessage(error) });
			},
		);
		return () => controller.abort();
	}, [path, schema, requestKey]);
	return {
		data: result.key === requestKey ? result.data : undefined,
		error: result.key === requestKey ? result.error : undefined,
		loading: result.key !== requestKey,
		refresh: () => setVersion((value) => value + 1),
	};
}

export function useAction() {
	const lock = useRef(false);
	const mounted = useRef(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	const [success, setSuccess] = useState<string>();
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	async function run(action: () => Promise<void>, message?: string) {
		if (lock.current) return;
		lock.current = true;
		setPending(true);
		setError(undefined);
		setSuccess(undefined);
		try {
			await action();
			if (mounted.current && message) setSuccess(message);
		} catch (failure) {
			if (mounted.current) setError(errorMessage(failure));
		} finally {
			lock.current = false;
			if (mounted.current) setPending(false);
		}
	}
	return { pending, error, success, run };
}

export function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
	return (
		<>
			{action.error && <Notice tone="err">{action.error}</Notice>}
			{action.success && <Notice tone="ok">{action.success}</Notice>}
			{action.pending && (
				<p className="text-xs text-fg-3" role="status">
					Saving… Please wait before making another change.
				</p>
			)}
		</>
	);
}

// Grey rows that hold the collection's shape while it loads.
export function LoadingRows({
	label,
	rows = 8,
}: {
	label: string;
	rows?: number;
}) {
	return (
		<div className={tableFrameClass} role="status" aria-label={label}>
			<div className="h-9 border-b border-line" />
			<ul className="m-0 list-none divide-y divide-line-subtle p-0">
				{Array.from({ length: rows }, (_, index) => (
					<li
						key={index}
						className="flex h-12 items-center gap-6 px-4 motion-safe:animate-pulse"
					>
						<span className="h-2.5 w-2/5 rounded-full bg-selected" />
						<span className="hidden h-2.5 w-1/6 rounded-full bg-hover sm:block" />
						<span className="ml-auto h-2.5 w-16 rounded-full bg-hover" />
					</li>
				))}
			</ul>
		</div>
	);
}

export function ResourceState({
	loading,
	error,
	retry,
	label = "Loading vault records",
}: {
	loading: boolean;
	error?: string;
	retry: () => void;
	label?: string;
}) {
	if (loading) return <LoadingRows label={label} />;
	if (error)
		return (
			<div className="grid gap-3">
				<Notice tone="err">{error}</Notice>
				<div>
					<Button variant="secondary" onClick={retry}>
						Try again
					</Button>
				</div>
			</div>
		);
	return null;
}

// The page header mirrors the product shell: an optional parent trail, one
// title row with status, a one-line description and the page's actions.
export function PageHeader({
	title,
	description,
	parents = [],
	status,
	headingRef,
	children,
}: {
	title: string;
	description?: ReactNode;
	parents?: { label: string; onSelect: () => void }[];
	status?: ReactNode;
	headingRef?: Ref<HTMLHeadingElement>;
	children?: ReactNode;
}) {
	return (
		<header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 md:flex-nowrap">
			<div className="min-w-0 flex-1 basis-full md:basis-auto">
				{parents.length > 0 && (
					<nav aria-label="Breadcrumb" className="mb-1.5">
						<ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-1.5 p-0 text-sm text-fg-3">
							{parents.map((parent) => (
								<li
									key={parent.label}
									className="flex min-w-0 items-center gap-1.5"
								>
									<button
										type="button"
										className="truncate rounded-sm text-fg-3 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
										onClick={parent.onSelect}
									>
										{parent.label}
									</button>
									<span aria-hidden="true" className="text-fg-4">
										/
									</span>
								</li>
							))}
						</ol>
					</nav>
				)}
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
					<h1
						ref={headingRef}
						tabIndex={headingRef ? -1 : undefined}
						className="m-0 line-clamp-2 min-w-0 text-xl font-semibold break-words text-fg outline-none"
						title={title}
					>
						{title}
					</h1>
					{status}
				</div>
				{description && (
					<p className="mt-1 mb-0 max-w-[70ch] text-sm text-fg-3">
						{description}
					</p>
				)}
			</div>
			{children && (
				<div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
					{children}
				</div>
			)}
		</header>
	);
}

// A titled group inside a page: a hairline, a section title and its actions.
export function Section({
	id,
	title,
	description,
	action,
	children,
}: {
	id: string;
	title: string;
	description?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section
			aria-labelledby={id}
			className="grid min-w-0 gap-3 border-t border-line py-6 first:border-t-0 first:pt-0"
		>
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
				<div className="min-w-0">
					<h2 id={id} className="m-0 text-base font-semibold text-fg">
						{title}
					</h2>
					{description && (
						<p className="mt-1 mb-0 text-xs leading-relaxed text-fg-3">
							{description}
						</p>
					)}
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

export function EmptyState({
	title,
	children,
	action,
}: {
	title: string;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="rounded-lg border border-dashed border-line-strong px-5 py-10 text-center">
			<h2 className="m-0 text-sm font-medium text-fg">{title}</h2>
			<p className="mx-auto mt-1.5 mb-0 max-w-xl text-sm leading-relaxed text-fg-3">
				{children}
			</p>
			{action && (
				<div className="mt-4 flex justify-center text-sm">{action}</div>
			)}
		</div>
	);
}

export function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<label className={fieldLabelClass}>
			{label}
			{children}
			{hint && <span className="text-xs font-normal text-fg-3">{hint}</span>}
		</label>
	);
}

function initials(name: string): string {
	const letters = name
		.trim()
		.split(/\s+/)
		.map((part) => part.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
		.filter(Boolean);
	if (!letters.length) return "?";
	return (
		letters.length === 1 ? letters[0]! : letters[0]! + letters.at(-1)!
	).toUpperCase();
}

const avatarSizeClasses = {
	sm: "size-5 text-3xs",
	md: "size-7 text-2xs",
} as const;

export function Avatar({
	name,
	size = "sm",
}: {
	name: string;
	size?: keyof typeof avatarSizeClasses;
}) {
	return (
		<span
			aria-hidden="true"
			className={
				"grid shrink-0 place-items-center rounded-full border border-line bg-surface font-semibold text-fg-2 " +
				avatarSizeClasses[size]
			}
		>
			{initials(name)}
		</span>
	);
}

export function Person({ name }: { name: string }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<Avatar name={name || "?"} />
			<span className="truncate text-fg-2">{name || "Unnamed"}</span>
		</span>
	);
}

const sourceSchema = z.enum(["claude", "codex", "cursor"]);

export function sourceLabel(source: string): string {
	const known = sourceSchema.safeParse(source);
	return known.success ? collectorSourceLabel(known.data) : source;
}

export function SourceMark({ source }: { source: string }) {
	const known = sourceSchema.safeParse(source);
	return (
		<span className="inline-flex min-w-0 items-center gap-1.5">
			{known.success && (
				<ToolLogo name={known.data} className="size-3.5 shrink-0 text-fg" />
			)}
			<span className="truncate">{sourceLabel(source)}</span>
		</span>
	);
}

export function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatDay(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year:
			date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
	});
}

const relativeUnits = [
	["day", 86_400_000],
	["hour", 3_600_000],
	["minute", 60_000],
] as const;

// Recent records read as relative time; older ones as a date. The exact time
// stays in the tooltip.
export function RelativeTime({ value }: { value: string }) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return <span>{value}</span>;
	const elapsed = Date.now() - date.getTime();
	let label = formatDay(value);
	if (elapsed < 60_000) label = "Just now";
	else if (elapsed < 7 * 86_400_000) {
		const [unit, size] = relativeUnits.find(([, size]) => elapsed >= size)!;
		label = new Intl.RelativeTimeFormat(undefined, {
			numeric: "auto",
			style: "short",
		}).format(-Math.floor(elapsed / size), unit);
	}
	return (
		<time dateTime={value} title={formatTime(value)}>
			{label}
		</time>
	);
}

export function pageSchema<T extends z.ZodType>(item: T) {
	return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export function usePage() {
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const cursor = cursors[cursors.length - 1];
	return {
		query: cursor ? `?cursor=${encodeURIComponent(cursor)}` : "",
		page: cursors.length,
		next: (nextCursor: string) => setCursors((value) => [...value, nextCursor]),
		previous: () => setCursors((value) => value.slice(0, -1)),
	};
}

export function Pagination({
	page,
	nextCursor,
	previous,
	next,
}: ReturnType<typeof usePage> & { nextCursor: string | null }) {
	if (page === 1 && !nextCursor) return null;
	return (
		<nav
			aria-label="Pagination"
			className="mt-3 flex flex-wrap items-center justify-between gap-3"
		>
			<p className="text-xs text-fg-3 tabular-nums">Page {page}</p>
			<div className="flex gap-1">
				<Button
					variant="secondary"
					size="sm"
					disabled={page === 1}
					onClick={previous}
				>
					<Icon name="chevronRight" size="sm" className="rotate-180" />
					Previous
				</Button>
				<Button
					variant="secondary"
					size="sm"
					disabled={!nextCursor}
					onClick={() => nextCursor && next(nextCursor)}
				>
					Next
					<Icon name="chevronRight" size="sm" />
				</Button>
			</div>
		</nav>
	);
}

// A shell command with a copy button; a failed copy says so instead of
// pretending to succeed.
export function CopyCommand({
	command,
	label,
}: {
	command: string;
	label: string;
}) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	return (
		<div className="grid gap-1.5">
			<p className="m-0 text-xs font-medium text-fg-2">{label}</p>
			<div className="flex min-w-0 items-center gap-3 rounded-lg border border-line-strong bg-canvas py-1.5 pr-1.5 pl-4">
				<code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-fg">
					<span aria-hidden="true" className="text-fg-4">
						${" "}
					</span>
					{command}
				</code>
				<Button
					variant="secondary"
					aria-label={`Copy: ${label}`}
					onClick={() => {
						if (!navigator.clipboard) return setState("failed");
						navigator.clipboard.writeText(command).then(
							() => setState("copied"),
							() => setState("failed"),
						);
					}}
				>
					<Icon name={state === "copied" ? "check" : "copy"} size="sm" />
					{state === "copied" ? "Copied" : "Copy"}
				</Button>
			</div>
			{state === "failed" && (
				<p className="m-0 text-xs text-err" role="alert">
					Copying failed. Select the command and copy it manually.
				</p>
			)}
		</div>
	);
}

// A ⋯ menu for rare and destructive actions, closed by Escape or a click away.
export function OverflowMenu({
	label,
	children,
}: {
	label: string;
	children: (close: () => void) => ReactNode;
}) {
	const details = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	const close = () => {
		if (details.current) details.current.open = false;
	};
	useEffect(() => {
		if (!open) return;
		details.current
			?.querySelector<HTMLButtonElement>('[role="menuitem"]')
			?.focus();
		const outside = (event: PointerEvent) => {
			if (
				event.target instanceof Node &&
				!details.current?.contains(event.target)
			)
				close();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			close();
			details.current?.querySelector<HTMLElement>("summary")?.focus();
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);
	return (
		<details
			ref={details}
			className="relative"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				title={label}
				className="grid size-8 cursor-pointer list-none place-items-center rounded-md border border-line-strong bg-raised text-fg-2 shadow-sm transition-colors hover:border-fg-4 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
			>
				<Icon name="more" size="sm" />
			</summary>
			<div
				role="menu"
				aria-label={label}
				className={
					popoverClasses.menu +
					" absolute top-full right-0 z-30 mt-1 grid w-52 gap-0.5"
				}
			>
				{children(close)}
			</div>
		</details>
	);
}

export function ConfirmAction({
	label,
	title,
	consequence,
	path,
	method = "DELETE",
	body,
	onDone,
	onCancel,
	typed = false,
	destructive = true,
	open: controlled,
}: {
	label: string;
	title: string;
	consequence: string;
	path: string;
	method?: string;
	body?: unknown;
	onDone: () => void;
	onCancel?: () => void;
	typed?: boolean;
	destructive?: boolean;
	open?: boolean;
}) {
	const [opened, setOpened] = useState(false);
	const open = controlled ?? opened;
	const [confirmation, setConfirmation] = useState("");
	const action = useAction();
	if (!open)
		return (
			<Button
				variant={destructive ? "danger" : "secondary"}
				onClick={() => setOpened(true)}
			>
				{label}
			</Button>
		);
	return (
		<form
			className={
				destructive
					? "grid w-full gap-3 rounded-lg border border-err/30 bg-err/5 p-4"
					: "grid w-full gap-3 rounded-lg border border-line bg-raised p-4"
			}
			onSubmit={(event) => {
				event.preventDefault();
				if (typed && confirmation !== "DELETE") return;
				void action.run(async () => {
					await api(path, emptySchema, { method, body });
					setOpened(false);
					onDone();
				});
			}}
		>
			<p className="text-sm font-semibold">{title}</p>
			<p className="max-w-[70ch] text-sm text-fg-2">{consequence}</p>
			{typed && (
				<div className="max-w-xs">
					<Field label="Type DELETE to confirm">
						<Input
							autoComplete="off"
							autoFocus
							required
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
						/>
					</Field>
				</div>
			)}
			<Feedback action={action} />
			<div className="flex flex-wrap gap-2">
				<Button
					variant={destructive ? "danger" : "secondary"}
					type="submit"
					disabled={action.pending || (typed && confirmation !== "DELETE")}
				>
					{action.pending ? "Please wait…" : title}
				</Button>
				<Button
					variant="ghost"
					disabled={action.pending}
					onClick={() => {
						setOpened(false);
						setConfirmation("");
						onCancel?.();
					}}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
