import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { Button } from "../../../src/shared/ui/button";
import { Input, fieldLabelClass } from "../../../src/shared/ui/field";
import { Notice } from "../../../src/shared/ui/notice";

export { Button, buttonClasses } from "../../../src/shared/ui/button";
export { Input, Select } from "../../../src/shared/ui/field";
export { Notice } from "../../../src/shared/ui/notice";
export {
	Panel,
	codeBlockClass,
	popoverClasses,
} from "../../../src/shared/ui/panel";
export { List } from "../../../src/shared/ui/list";
export { Icon } from "../../../src/shared/ui/icon";
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

export function ResourceState({
	loading,
	error,
	retry,
}: {
	loading: boolean;
	error?: string;
	retry: () => void;
}) {
	if (loading)
		return (
			<p className="py-8 text-sm text-fg-3" role="status">
				Loading vault records…
			</p>
		);
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

export function Heading({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children?: ReactNode;
}) {
	return (
		<header className="mb-6 flex flex-wrap items-start justify-between gap-3">
			<div className="min-w-0">
				<h1 className="text-2xl font-medium text-fg">{title}</h1>
				<p className="mt-1 max-w-2xl text-sm text-fg-3">{description}</p>
			</div>
			{children}
		</header>
	);
}

export function Field({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<label className={fieldLabelClass}>
			{label}
			{children}
		</label>
	);
}

export function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
	return (
		<nav
			aria-label="Pagination"
			className="mt-3 flex flex-wrap items-center justify-between gap-3"
		>
			<p className="text-xs text-fg-3">Page {page}</p>
			<div className="flex gap-1">
				<Button
					variant="ghost"
					size="sm"
					disabled={page === 1}
					onClick={previous}
				>
					Previous
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={!nextCursor}
					onClick={() => nextCursor && next(nextCursor)}
				>
					Next page
				</Button>
			</div>
		</nav>
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
	typed = false,
	destructive = true,
}: {
	label: string;
	title: string;
	consequence: string;
	path: string;
	method?: string;
	body?: unknown;
	onDone: () => void;
	typed?: boolean;
	destructive?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const action = useAction();
	if (!open)
		return (
			<Button
				variant={destructive ? "danger" : "secondary"}
				onClick={() => setOpen(true)}
			>
				{label}
			</Button>
		);
	return (
		<form
			className="grid w-full gap-3 rounded-lg border border-line-strong bg-raised p-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (typed && confirmation !== "DELETE") return;
				void action.run(async () => {
					await api(path, emptySchema, { method, body });
					setOpen(false);
					onDone();
				});
			}}
		>
			<p className="text-sm font-semibold">{title}</p>
			<p className="text-sm text-fg-2">{consequence}</p>
			{typed && (
				<Field label="Type DELETE to confirm">
					<Input
						autoComplete="off"
						required
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
					/>
				</Field>
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
						setOpen(false);
						setConfirmation("");
					}}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}
