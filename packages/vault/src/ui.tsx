import {
	Component,
	Fragment,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { z } from "zod";
import { BrandMark } from "../../../src/shared/ui/brand";
import { Audit } from "./ui-audit";
import { CaptureRules } from "./ui-collection-rules";
import { Collectors } from "./ui-collectors";
import {
	ApiError,
	Avatar,
	Badge,
	Button,
	Feedback,
	Field,
	Icon,
	Input,
	Notice,
	SESSION_EXPIRED_EVENT,
	api,
	emptySchema,
	errorMessage,
	meSchema,
	memberSchema,
	popoverClasses,
	useAction,
	type Member,
} from "./ui-common";
import { People } from "./ui-people";
import { RepositoryPolicy } from "./ui-repositories";
import { Sessions } from "./ui-sessions";

const statusSchema = z.object({
	initialized: z.boolean(),
	name: z.string().nullable(),
});
const authSchema = z.object({ member: memberSchema });
type Status = z.infer<typeof statusSchema>;
type Identity = z.infer<typeof meSchema>;
type BootState =
	| { kind: "loading" }
	| { kind: "error"; error: string }
	| { kind: "public"; status: Status; expired?: boolean }
	| { kind: "authenticated"; identity: Identity };
type View =
	| "sessions"
	| "rules"
	| "collectors"
	| "repositories"
	| "people"
	| "audit";

function captureInvitation(): { joining: boolean; token: string } {
	const joining = window.location.pathname.replace(/\/$/, "") === "/join";
	if (!joining) return { joining: false, token: "" };
	const fragment = window.location.hash.slice(1);
	window.history.replaceState(
		null,
		"",
		window.location.pathname + window.location.search,
	);
	try {
		return { joining: true, token: decodeURIComponent(fragment) };
	} catch {
		return { joining: true, token: "" };
	}
}

export function VaultApp() {
	return (
		<VaultErrorBoundary>
			<VaultApplication />
		</VaultErrorBoundary>
	);
}

function VaultApplication() {
	const [invitation, setInvitation] = useState(captureInvitation);
	const [state, setState] = useState<BootState>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const controller = new AbortController();
		async function load() {
			try {
				const status = await api("/api/status", statusSchema, {
					signal: controller.signal,
				});
				if (!status.initialized) {
					if (!controller.signal.aborted) setState({ kind: "public", status });
					return;
				}
				try {
					const identity = await api("/api/me", meSchema, {
						signal: controller.signal,
					});
					if (!controller.signal.aborted)
						setState({ kind: "authenticated", identity });
				} catch (error) {
					if (error instanceof ApiError && error.status === 401) {
						if (!controller.signal.aborted)
							setState({ kind: "public", status });
					} else throw error;
				}
			} catch (error) {
				if (!controller.signal.aborted)
					setState({ kind: "error", error: errorMessage(error) });
			}
		}
		void load();
		return () => controller.abort();
	}, [attempt]);
	useEffect(() => {
		function expired() {
			setState((previous) => ({
				kind: "public",
				status: {
					initialized: true,
					name:
						previous.kind === "authenticated"
							? previous.identity.vaultName
							: null,
				},
				expired: true,
			}));
		}
		window.addEventListener(SESSION_EXPIRED_EVENT, expired);
		return () => window.removeEventListener(SESSION_EXPIRED_EVENT, expired);
	}, []);
	useEffect(() => {
		const vaultName =
			state.kind === "authenticated"
				? state.identity.vaultName
				: state.kind === "public"
					? state.status.name
					: null;
		document.title = vaultName
			? `${vaultName.slice(0, 100)} · Trace Vault`
			: "Trace Vault";
	}, [state]);
	function authenticated(identity: Identity) {
		setInvitation({ joining: false, token: "" });
		window.history.replaceState(null, "", "/");
		setState({ kind: "authenticated", identity });
	}
	return (
		<div className="min-h-screen bg-canvas font-sans text-fg">
			{state.kind === "loading" && (
				<AccessFrame>
					<p role="status" className="text-center text-sm text-fg-3">
						Opening the vault…
					</p>
				</AccessFrame>
			)}
			{state.kind === "error" && (
				<AccessFrame>
					<AccessHeading
						title="Vault unavailable"
						description="The vault could not be opened. Check your connection or contact your administrator."
					/>
					<div className="grid gap-4">
						<Notice tone="err">{state.error}</Notice>
						<Button
							variant="primary"
							size="lg"
							onClick={() => {
								setState({ kind: "loading" });
								setAttempt((value) => value + 1);
							}}
						>
							Try opening again
						</Button>
					</div>
				</AccessFrame>
			)}
			{state.kind !== "loading" &&
				state.kind !== "error" &&
				(invitation.joining ? (
					<AccessFrame>
						<JoinForm
							token={invitation.token}
							name={
								state.kind === "authenticated"
									? state.identity.vaultName
									: state.status.name
							}
							signedIn={state.kind === "authenticated"}
							onAuthenticated={authenticated}
							onCancel={() => {
								setInvitation({ joining: false, token: "" });
								window.history.replaceState(null, "", "/");
							}}
						/>
					</AccessFrame>
				) : state.kind === "public" ? (
					<AccessFrame>
						{state.expired && (
							<div className="mb-5">
								<Notice tone="warn">
									Your session has ended or your access changed. Sign in again
									to continue.
								</Notice>
							</div>
						)}
						<AccessForm status={state.status} onAuthenticated={authenticated} />
					</AccessFrame>
				) : (
					<Workspace
						key={`${state.identity.member.id}:${state.identity.member.role}`}
						identity={state.identity}
						onSignedOut={() =>
							setState({
								kind: "public",
								status: { initialized: true, name: state.identity.vaultName },
							})
						}
					/>
				))}
		</div>
	);
}

function Lockup() {
	return (
		<span className="inline-flex items-center gap-2 text-fg">
			<BrandMark />
			<span className="text-md font-semibold">Trace Vault</span>
		</span>
	);
}

// Sign-in, setup and invitations share the product's access frame: the
// wordmark over a hairline, then one white card.
function AccessFrame({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-screen flex-col bg-canvas text-fg">
			<header className="flex h-19 shrink-0 items-center border-b border-line px-5 sm:px-8">
				<Lockup />
			</header>
			<main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-5">
				<div className="w-full max-w-100 rounded-xl border border-line bg-raised p-6 shadow-md sm:p-8">
					{children}
				</div>
			</main>
		</div>
	);
}

function AccessHeading({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="mb-6">
			<h1 className="m-0 text-2xl font-semibold text-fg">{title}</h1>
			<p className="mt-1.5 mb-0 text-sm leading-relaxed text-fg-3">
				{description}
			</p>
		</div>
	);
}

function AccessForm({
	status,
	onAuthenticated,
}: {
	status: Status;
	onAuthenticated: (identity: Identity) => void;
}) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [companyName, setCompanyName] = useState("");
	const [bootstrapToken, setBootstrapToken] = useState("");
	const [accepted, setAccepted] = useState(false);
	const action = useAction();
	const setup = !status.initialized;
	return (
		<>
			<AccessHeading
				title={setup ? "Set up your vault" : "Sign in"}
				description={
					setup
						? "Name the vault and create its first administrator with the bootstrap token from your deployment."
						: status.name
							? `Continue to ${status.name}.`
							: "Use your vault account to continue."
				}
			/>
			<form
				className="grid gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					void action.run(async () => {
						if (!accepted) {
							await api(setup ? "/api/setup" : "/api/auth/login", authSchema, {
								method: "POST",
								body: setup
									? {
											bootstrapToken,
											name: companyName.trim(),
											email: email.trim(),
											password,
											displayName: displayName.trim(),
										}
									: { email: email.trim(), password },
							});
							setAccepted(true);
						}
						setPassword("");
						setBootstrapToken("");
						const identity = await api("/api/me", meSchema);
						onAuthenticated(identity);
					});
				}}
			>
				<fieldset
					disabled={action.pending || accepted}
					className="grid min-w-0 gap-4"
				>
					{setup && (
						<>
							<Field label="Bootstrap token">
								<Input
									size="lg"
									type="password"
									required
									autoComplete="off"
									value={bootstrapToken}
									onChange={(event) => setBootstrapToken(event.target.value)}
								/>
							</Field>
							<Field label="Vault name">
								<Input
									size="lg"
									required
									placeholder="Acme Engineering"
									value={companyName}
									onChange={(event) => setCompanyName(event.target.value)}
									autoComplete="organization"
								/>
							</Field>
							<Field label="Your name">
								<Input
									size="lg"
									required
									value={displayName}
									onChange={(event) => setDisplayName(event.target.value)}
									autoComplete="name"
								/>
							</Field>
						</>
					)}
					<Field label="Work email">
						<Input
							size="lg"
							type="email"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
							autoComplete="username"
						/>
					</Field>
					<Field
						label={setup ? "Create a password" : "Password"}
						hint={setup ? "12 to 256 characters." : undefined}
					>
						<Input
							size="lg"
							type="password"
							required
							minLength={setup ? 12 : undefined}
							maxLength={256}
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							autoComplete={setup ? "new-password" : "current-password"}
						/>
					</Field>
				</fieldset>
				{accepted && (
					<Notice tone="neutral">
						Sign-in was accepted. If the vault did not open, use Open vault to
						retry without resubmitting your credentials.
					</Notice>
				)}
				<Feedback action={action} />
				<Button
					variant="primary"
					size="lg"
					type="submit"
					className="mt-1"
					disabled={action.pending}
				>
					{action.pending
						? "Please wait…"
						: accepted
							? "Open vault"
							: setup
								? "Create vault"
								: "Sign in"}
				</Button>
				{!setup && (
					<p className="m-0 text-xs leading-relaxed text-fg-3">
						New members join through a private invitation link. For access or a
						password reset, contact your vault administrator.
					</p>
				)}
			</form>
		</>
	);
}

function JoinForm({
	token,
	name,
	signedIn,
	onAuthenticated,
	onCancel,
}: {
	token: string;
	name: string | null;
	signedIn: boolean;
	onAuthenticated: (identity: Identity) => void;
	onCancel: () => void;
}) {
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [accepted, setAccepted] = useState(false);
	const action = useAction();
	return (
		<>
			<AccessHeading
				title={name ? `Join ${name}` : "Join the vault"}
				description="Create a password to accept your invitation. Your name and email come from the invitation."
			/>
			{!token ? (
				<div className="grid gap-4">
					<Notice tone="err">
						This page has no valid invitation token. Reopen the original private
						invitation link. If it has expired or was already used, ask your
						administrator for a new one.
					</Notice>
					<Button variant="secondary" size="lg" onClick={onCancel}>
						Return to sign in
					</Button>
				</div>
			) : (
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void action.run(async () => {
							if (!accepted) {
								if (password !== confirmation)
									throw new Error(
										"The passwords do not match. Re-enter the confirmation.",
									);
								await api("/api/auth/join", authSchema, {
									method: "POST",
									body: { token, password },
								});
								setAccepted(true);
							}
							setPassword("");
							setConfirmation("");
							onAuthenticated(await api("/api/me", meSchema));
						});
					}}
				>
					{signedIn && (
						<Notice tone="warn">
							You are already signed in. Accepting this invitation replaces the
							current browser session with the invited account.
						</Notice>
					)}
					<fieldset
						disabled={action.pending || accepted}
						className="grid min-w-0 gap-4"
					>
						<Field label="Create a password" hint="12 to 256 characters.">
							<Input
								size="lg"
								type="password"
								required
								minLength={12}
								maxLength={256}
								autoComplete="new-password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
							/>
						</Field>
						<Field label="Confirm password">
							<Input
								size="lg"
								type="password"
								required
								autoComplete="new-password"
								value={confirmation}
								onChange={(event) => setConfirmation(event.target.value)}
							/>
						</Field>
					</fieldset>
					{accepted && (
						<Notice tone="neutral">
							Invitation accepted. Use Open vault to retry; the one-time
							invitation will not be submitted again.
						</Notice>
					)}
					<Feedback action={action} />
					<Button
						variant="primary"
						size="lg"
						type="submit"
						className="mt-1"
						disabled={action.pending}
					>
						{action.pending
							? "Please wait…"
							: accepted
								? "Open vault"
								: "Accept invitation"}
					</Button>
					<Button variant="ghost" disabled={action.pending} onClick={onCancel}>
						Cancel
					</Button>
					<p className="m-0 text-xs leading-relaxed text-fg-3">
						The private token was removed from the address bar and is held only
						in this page’s memory. After a reload, reopen the original link.
					</p>
				</form>
			)}
		</>
	);
}

type NavigationItem = {
	view: View;
	label: string;
	icon: Parameters<typeof Icon>[0]["name"];
};

// The sidebar groups the archive, how work reaches it, and administration.
const navigationGroups: {
	label: string | null;
	admin: boolean;
	items: NavigationItem[];
}[] = [
	{
		label: null,
		admin: false,
		items: [{ view: "sessions", label: "Sessions", icon: "sessions" }],
	},
	{
		label: "Collection",
		admin: false,
		items: [
			{ view: "rules", label: "Collection rules", icon: "filter" },
			{ view: "collectors", label: "Collectors", icon: "collectors" },
		],
	},
	{
		label: "Administration",
		admin: true,
		items: [
			{ view: "repositories", label: "Repositories", icon: "repository" },
			{ view: "people", label: "People", icon: "users" },
			{ view: "audit", label: "Audit log", icon: "plan" },
		],
	},
];

// One navigation serves both layouts: underlined tabs under the header on
// narrow screens and a sidebar list from the large breakpoint.
const navigationLinkClasses = {
	active:
		"group flex h-11 shrink-0 items-center gap-1.5 border-b-2 border-accent px-2 text-sm font-medium whitespace-nowrap text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent lg:h-8 lg:w-full lg:gap-2.5 lg:rounded-md lg:border-b-0 lg:bg-selected lg:px-2.5",
	idle: "group flex h-11 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2 text-sm whitespace-nowrap text-fg-3 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent lg:h-8 lg:w-full lg:gap-2.5 lg:rounded-md lg:border-b-0 lg:px-2.5 lg:text-fg-2 lg:hover:bg-hover",
} as const;

const navigationIconClasses = {
	active: "hidden text-fg sm:block",
	idle: "hidden text-fg-3 transition-colors group-hover:text-fg-2 sm:block",
} as const;

// Settings pages stay at a readable width; collections use the full width.
const viewWidthClasses = {
	sessions: "mx-auto w-full max-w-360",
	collectors: "mx-auto w-full max-w-360",
	people: "mx-auto w-full max-w-360",
	audit: "mx-auto w-full max-w-360",
	rules: "mx-auto w-full max-w-4xl",
	repositories: "mx-auto w-full max-w-4xl",
} as const satisfies Record<View, string>;

function vaultMonogram(name: string): string {
	return (
		name
			.trim()
			.match(/[\p{L}\p{N}]/u)?.[0]
			?.toUpperCase() ?? "V"
	);
}

function Navigation({
	member,
	view,
	onSelect,
}: {
	member: Member;
	view: View;
	onSelect: (view: View) => void;
}) {
	return (
		<nav
			aria-label="Vault navigation"
			className="order-last flex basis-full gap-1 overflow-x-auto border-t border-line-subtle px-2 sm:gap-2 sm:px-3 lg:order-none lg:mx-3 lg:mt-1 lg:min-h-0 lg:flex-1 lg:basis-auto lg:flex-col lg:gap-0 lg:overflow-y-auto lg:border-t-0 lg:px-0"
		>
			{navigationGroups
				.filter((group) => !group.admin || member.role === "admin")
				.map((group) => (
					<Fragment key={group.label ?? "archive"}>
						{group.label !== null && (
							<p className="m-0 mt-5 mb-1 hidden px-2.5 text-xs font-medium text-fg-3 lg:block">
								{group.label}
							</p>
						)}
						<div className="contents lg:grid lg:gap-0.5">
							{group.items.map((item) => {
								const active = view === item.view;
								return (
									<button
										key={item.view}
										type="button"
										aria-current={active ? "page" : undefined}
										className={
											active
												? navigationLinkClasses.active
												: navigationLinkClasses.idle
										}
										onClick={() => onSelect(item.view)}
									>
										<Icon
											className={
												active
													? navigationIconClasses.active
													: navigationIconClasses.idle
											}
											name={item.icon}
											size="sm"
										/>
										{item.label}
									</button>
								);
							})}
						</div>
					</Fragment>
				))}
		</nav>
	);
}

// Compact in the narrow header, a full account row at the sidebar's foot.
function AccountMenu({
	member,
	onSignedOut,
}: {
	member: Member;
	onSignedOut: () => void;
}) {
	const details = useRef<HTMLDetailsElement>(null);
	const [open, setOpen] = useState(false);
	const logout = useAction();
	const name = member.name || "Vault member";
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
				setOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			setOpen(false);
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
			open={open}
			className="relative min-w-0"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<summary
				role="button"
				aria-label={`Account: ${name}`}
				aria-haspopup="menu"
				aria-expanded={open}
				className="flex cursor-pointer list-none items-center gap-2.5 rounded-md p-0.5 transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:min-h-12 lg:px-2 lg:py-2 lg:focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden"
			>
				<Avatar name={name} size="md" />
				<span className="hidden min-w-0 flex-1 text-left lg:block">
					<span className="block truncate text-sm font-medium text-fg">
						{name}
					</span>
					<span className="block truncate text-xs text-fg-3">
						{member.email}
					</span>
				</span>
				<Icon
					className="hidden text-fg-3 lg:block"
					name="chevronsUpDown"
					size="sm"
				/>
			</summary>
			<div
				role="menu"
				aria-label="Your account"
				className={
					popoverClasses.menu +
					" absolute top-full right-0 z-30 mt-2 grid w-60 gap-0.5 lg:top-auto lg:right-auto lg:bottom-full lg:left-0 lg:mt-0 lg:mb-2 lg:w-56"
				}
			>
				<div className="mb-1 grid gap-1 border-b border-line-subtle px-2.5 pt-1.5 pb-2.5">
					<p className="m-0 truncate text-sm font-medium">{name}</p>
					<p className="m-0 truncate text-xs text-fg-3">{member.email}</p>
					<div className="mt-1">
						<Badge>
							{member.role === "admin" ? "Administrator" : "Member"}
						</Badge>
					</div>
				</div>
				{logout.error && <Notice tone="err">{logout.error}</Notice>}
				<Button
					role="menuitem"
					variant="ghost"
					size="sm"
					className="w-full justify-start"
					disabled={logout.pending}
					aria-busy={logout.pending}
					onClick={() => {
						void logout.run(async () => {
							await api("/api/auth/logout", emptySchema, { method: "POST" });
							onSignedOut();
						});
					}}
				>
					{logout.pending ? "Signing out…" : "Sign out"}
				</Button>
			</div>
		</details>
	);
}

function Workspace({
	identity,
	onSignedOut,
}: {
	identity: Identity;
	onSignedOut: () => void;
}) {
	const [view, setView] = useState<View>("sessions");
	const main = useRef<HTMLElement>(null);
	const { member, vaultName } = identity;
	useEffect(() => {
		main.current?.focus();
	}, [view]);
	return (
		<div className="flex min-h-screen flex-col bg-canvas text-fg lg:flex-row">
			<a
				href="#vault-content"
				className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-fg"
			>
				Skip to content
			</a>
			<aside className="sticky top-0 z-20 flex shrink-0 flex-wrap items-center border-b border-line bg-canvas/95 backdrop-blur-md lg:h-screen lg:w-60 lg:flex-col lg:flex-nowrap lg:items-stretch lg:border-r lg:border-b-0 lg:bg-canvas lg:backdrop-blur-none">
				<div className="flex h-14 min-w-0 flex-1 items-center gap-3 pl-4 sm:pl-6 lg:h-auto lg:flex-none lg:flex-col lg:items-stretch lg:gap-0 lg:pl-0">
					<span className="flex shrink-0 items-center gap-2 text-fg lg:h-14 lg:px-5">
						<BrandMark />
						<span className="hidden text-md font-semibold lg:inline">
							Trace Vault
						</span>
					</span>
					<span className="flex min-w-0 flex-1 items-center gap-2.5 lg:mx-3 lg:h-10 lg:flex-none lg:px-2">
						<span
							aria-hidden="true"
							className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-fg"
						>
							{vaultMonogram(vaultName)}
						</span>
						<span
							className="min-w-0 flex-1 truncate text-sm font-medium text-fg"
							title={vaultName}
						>
							{vaultName}
						</span>
					</span>
				</div>
				<Navigation member={member} view={view} onSelect={setView} />
				<div className="px-4 sm:px-6 lg:order-last lg:mx-3 lg:mt-2 lg:border-t lg:border-line-subtle lg:px-0 lg:py-2">
					<AccountMenu member={member} onSignedOut={onSignedOut} />
				</div>
			</aside>
			<main
				ref={main}
				id="vault-content"
				tabIndex={-1}
				className="min-w-0 flex-1 px-4 pt-6 pb-12 outline-none sm:px-6 lg:px-10 lg:pt-8"
			>
				<div className={viewWidthClasses[view]}>
					{view === "sessions" && (
						<Sessions
							member={member}
							onCollectors={() => setView("collectors")}
						/>
					)}
					{view === "rules" && <CaptureRules />}
					{view === "collectors" && (
						<Collectors onRules={() => setView("rules")} />
					)}
					{view === "repositories" && member.role === "admin" && (
						<RepositoryPolicy />
					)}
					{view === "people" && member.role === "admin" && <People />}
					{view === "audit" && member.role === "admin" && <Audit />}
				</div>
			</main>
		</div>
	);
}

class VaultErrorBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		if (this.state.failed)
			return (
				<AccessFrame>
					<AccessHeading
						title="Unable to display the vault"
						description="The interface hit an unexpected error. Reload to restore your signed-in session."
					/>
					<div className="grid gap-4">
						<Notice tone="err">
							Unsaved changes and any invitation link shown only once may be
							lost when you reload.
						</Notice>
						<Button
							variant="primary"
							size="lg"
							onClick={() => window.location.reload()}
						>
							Reload vault
						</Button>
					</div>
				</AccessFrame>
			);
		return this.props.children;
	}
}
