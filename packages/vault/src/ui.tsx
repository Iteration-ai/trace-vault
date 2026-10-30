import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { Audit } from "./ui-audit";
import { CaptureRules } from "./ui-collection-rules";
import { Collectors } from "./ui-collectors";
import {
	ApiError,
	Button,
	Feedback,
	Field,
	Heading,
	Icon,
	Input,
	Notice,
	Panel,
	SESSION_EXPIRED_EVENT,
	api,
	emptySchema,
	errorMessage,
	meSchema,
	memberSchema,
	popoverClasses,
	useAction,
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
			? `${vaultName.slice(0, 100)} · Trace vault`
			: "Trace vault";
	}, [state]);
	function authenticated(identity: Identity) {
		setInvitation({ joining: false, token: "" });
		window.history.replaceState(null, "", "/");
		setState({ kind: "authenticated", identity });
	}
	return (
		<div
			data-theme="light"
			data-theme-scope="document"
			className="min-h-screen bg-canvas font-sans text-fg"
		>
			{state.kind === "loading" && (
				<AccessFrame>
					<p role="status" className="py-8 text-sm text-fg-3">
						Opening company vault…
					</p>
				</AccessFrame>
			)}
			{state.kind === "error" && (
				<AccessFrame>
					<Heading
						title="Vault unavailable"
						description="The vault could not be opened. Check your connection or contact your administrator."
					/>
					<div className="grid gap-4">
						<Notice tone="err">{state.error}</Notice>
						<div>
							<Button
								variant="primary"
								onClick={() => {
									setState({ kind: "loading" });
									setAttempt((value) => value + 1);
								}}
							>
								Try opening again
							</Button>
						</div>
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

function AccessFrame({ children }: { children: ReactNode }) {
	return (
		<main className="mx-auto grid min-h-screen w-full max-w-lg content-center gap-6 px-5 py-12 sm:px-8">
			<div className="flex items-center gap-3">
				<span
					className="grid size-9 place-items-center rounded-lg border border-line-strong font-mono text-sm font-semibold"
					aria-hidden="true"
				>
					tv
				</span>
				<span className="text-base font-semibold">Trace vault</span>
			</div>
			<Panel>{children}</Panel>
			<p className="text-xs text-fg-3">
				Company-owned traces. Access controlled by your company.
			</p>
		</main>
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
			<Heading
				title={setup ? "Set up your company vault" : "Sign in"}
				description={
					setup
						? "Create the company and its first administrator. Use the bootstrap token provided by your deployment administrator."
						: status.name
							? `Continue to ${status.name}.`
							: "Use your company vault account to continue."
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
							<Field label="Deployment bootstrap token">
								<Input
									size="lg"
									type="password"
									required
									autoComplete="off"
									value={bootstrapToken}
									onChange={(event) => setBootstrapToken(event.target.value)}
								/>
							</Field>
							<Field label="Company vault name">
								<Input
									size="lg"
									required
									value={companyName}
									onChange={(event) => setCompanyName(event.target.value)}
									autoComplete="organization"
								/>
							</Field>
							<Field label="Your display name">
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
					<Field label={setup ? "Create a password" : "Password"}>
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
				{setup && (
					<p className="text-xs text-fg-3">
						Use a password of 12–256 characters.
					</p>
				)}
				{accepted && (
					<Notice tone="neutral">
						Sign-in was accepted. If the vault did not open, use Open vault to
						retry the session check without resubmitting your credentials.
					</Notice>
				)}
				<Feedback action={action} />
				<Button
					variant="primary"
					size="lg"
					type="submit"
					disabled={action.pending}
				>
					{action.pending
						? "Please wait…"
						: accepted
							? "Open vault"
							: setup
								? "Create company vault"
								: "Sign in"}
				</Button>
				{!setup && (
					<p className="text-xs text-fg-3">
						Need an account or help signing in? Contact your vault
						administrator. New members join through a private invitation link.
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
			<Heading
				title="Join the company vault"
				description={
					name
						? `Accept your invitation to ${name}.`
						: "Accept the private invitation provided by your company administrator."
				}
			/>
			{!token ? (
				<div className="grid gap-4">
					<Notice tone="err">
						This page has no valid invitation token. Reopen the original private
						enrollment link. If it has expired or was already used, ask your
						administrator for a new invitation.
					</Notice>
					<Button variant="secondary" onClick={onCancel}>
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
							You are already signed in. Accepting this invitation will replace
							the current browser session with the invited account.
						</Notice>
					)}
					<fieldset
						disabled={action.pending || accepted}
						className="grid min-w-0 gap-4"
					>
						<Field label="Create a password">
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
					<p className="text-xs text-fg-3">
						Use a password of 12–256 characters. Your name and email are
						supplied by the invitation.
					</p>
					{accepted && (
						<Notice tone="neutral">
							Invitation accepted. Use Open vault to retry the session check;
							the one-time invitation will not be submitted again.
						</Notice>
					)}
					<p className="text-xs text-fg-3">
						The private token was removed from the address bar and is held only
						in this page’s memory. Reloading requires reopening the original
						invitation link.
					</p>
					<Feedback action={action} />
					<Button
						variant="primary"
						size="lg"
						type="submit"
						disabled={action.pending}
					>
						{action.pending
							? "Please wait…"
							: accepted
								? "Open vault"
								: "Accept invitation"}
					</Button>
					<Button variant="ghost" disabled={action.pending} onClick={onCancel}>
						Cancel invitation
					</Button>
				</form>
			)}
		</>
	);
}

const navigation: {
	view: View;
	label: string;
	icon: Parameters<typeof Icon>[0]["name"];
	admin?: boolean;
}[] = [
	{ view: "sessions", label: "Sessions", icon: "sessions" },
	{ view: "rules", label: "Collection rules", icon: "filter" },
	{ view: "collectors", label: "Collectors", icon: "collectors" },
	{
		view: "repositories",
		label: "Repositories",
		icon: "repository",
		admin: true,
	},
	{ view: "people", label: "People", icon: "users", admin: true },
	{ view: "audit", label: "Audit log", icon: "plan", admin: true },
];

function Workspace({
	identity,
	onSignedOut,
}: {
	identity: Identity;
	onSignedOut: () => void;
}) {
	const [view, setView] = useState<View>("sessions");
	const main = useRef<HTMLElement>(null);
	const logout = useAction();
	const { member, vaultName } = identity;
	const permitted = navigation.filter(
		(item) => !item.admin || member.role === "admin",
	);
	useEffect(() => {
		main.current?.focus();
	}, [view]);
	return (
		<div className="min-h-screen md:flex">
			<a
				href="#vault-content"
				className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:bg-canvas focus:p-3 focus:text-fg"
			>
				Skip to content
			</a>
			<aside className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] border-b border-line bg-canvas md:sticky md:top-0 md:flex md:h-screen md:w-52 md:flex-col md:overflow-y-auto md:border-r md:border-b-0">
				<div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3 md:py-5">
					<div className="min-w-0">
						<p className="mb-1 text-2xs text-fg-3">Trace vault</p>
						<p className="truncate text-sm font-semibold" title={vaultName}>
							{vaultName}
						</p>
					</div>
				</div>
				<nav
					aria-label="Vault navigation"
					className="col-span-2 flex gap-0.5 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible"
				>
					{permitted.map((item) => (
						<Button
							key={item.view}
							variant="ghost"
							size="sm"
							className="justify-start md:w-full"
							aria-current={view === item.view ? "page" : undefined}
							onClick={() => setView(item.view)}
						>
							<Icon name={item.icon} size="sm" />
							<span
								className={view === item.view ? "font-semibold text-fg" : ""}
							>
								{item.label}
							</span>
							{view === item.view && (
								<span className="ml-auto size-1 rounded-full bg-fg" />
							)}
						</Button>
					))}
				</nav>
				<div className="col-start-2 row-start-1 flex min-w-0 items-center border-line px-2 py-3 md:mt-auto md:border-t">
					<Button
						variant="ghost"
						size="sm"
						className="min-w-0 justify-start md:w-full"
						aria-label={`Account: ${member.name || "Vault member"}`}
						popoverTarget="vault-account"
					>
						<Icon name="users" size="sm" />
						<span className="hidden min-w-0 truncate md:inline">
							{member.name || "Vault member"}
						</span>
						<span className="ml-auto hidden md:inline-flex">
							<Icon name="chevronDown" size="xs" />
						</span>
					</Button>
					<div
						id="vault-account"
						popover="auto"
						role="group"
						aria-label="Your account"
						className={
							popoverClasses.menu +
							" fixed top-14 right-3 bottom-auto left-auto m-0 w-64 max-w-[calc(100vw-1.5rem)] md:top-auto md:right-auto md:bottom-14 md:left-3 md:w-48"
						}
					>
						<div className="mb-1 border-b border-line px-2.5 py-2">
							<p className="break-words text-sm font-medium">
								{member.name || "Vault member"}
							</p>
							<p className="mt-0.5 break-all text-xs text-fg-3">
								{member.email}
							</p>
							<p className="mt-1 text-2xs text-fg-3">
								{member.role === "admin" ? "Administrator" : "Member"}
							</p>
						</div>
						{logout.error && <Notice tone="err">{logout.error}</Notice>}
						<Button
							variant="ghost"
							size="sm"
							className="w-full justify-start"
							disabled={logout.pending}
							aria-busy={logout.pending}
							onClick={() => {
								void logout.run(async () => {
									await api("/api/auth/logout", emptySchema, {
										method: "POST",
									});
									onSignedOut();
								});
							}}
						>
							{logout.pending ? "Signing out…" : "Sign out"}
						</Button>
					</div>
				</div>
			</aside>
			<main
				ref={main}
				id="vault-content"
				tabIndex={-1}
				className="min-w-0 flex-1 px-5 py-6 outline-none md:px-8"
			>
				<div
					className={
						view === "rules" || view === "repositories"
							? "mx-auto max-w-3xl"
							: "mx-auto max-w-7xl"
					}
				>
					<p className="mb-5 hidden items-center gap-2 text-2xs text-fg-3 sm:flex">
						<span className="max-w-48 truncate">{vaultName}</span>
						<Icon name="chevronRight" size="xs" />
						<span>{permitted.find((item) => item.view === view)?.label}</span>
					</p>
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
				<div
					data-theme="light"
					data-theme-scope="document"
					className="min-h-screen bg-canvas text-fg"
				>
					<AccessFrame>
						<Heading
							title="Unable to display the vault"
							description="The interface encountered an unexpected error. Reload to restore your signed-in session."
						/>
						<Notice tone="err">
							Unsaved changes and any invitation link shown only once may be
							lost when you reload.
						</Notice>
						<div className="mt-4">
							<Button
								variant="primary"
								onClick={() => window.location.reload()}
							>
								Reload vault
							</Button>
						</div>
					</AccessFrame>
				</div>
			);
		return this.props.children;
	}
}
