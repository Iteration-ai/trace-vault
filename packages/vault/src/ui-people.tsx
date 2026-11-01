import { Fragment, useId, useRef, useState } from "react";
import { z } from "zod";
import {
	Avatar,
	Badge,
	Button,
	Feedback,
	Field,
	Icon,
	Input,
	Notice,
	PageHeader,
	Pagination,
	ResourceState,
	Select,
	StatusText,
	api,
	disclosureSummaryClass,
	emptySchema,
	formatTime,
	memberSchema,
	pageSchema,
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

const membersSchema = pageSchema(
	memberSchema.extend({ disabled: z.boolean() }),
);
const invitationSchema = z.object({
	invitationToken: z.string(),
	expiresAt: z.string(),
});

export function People() {
	const page = usePage();
	const resource = useResource(`/api/members${page.query}`, membersSchema);
	const [inviting, setInviting] = useState(false);
	const [notice, setNotice] = useState("");
	const feedback = useRef<HTMLParagraphElement>(null);
	const invitationId = useId();
	return (
		<>
			<PageHeader title="People">
				<Button
					variant="secondary"
					disabled={resource.loading}
					onClick={resource.refresh}
				>
					Refresh
				</Button>
				<Button
					variant={inviting ? "secondary" : "primary"}
					aria-expanded={inviting}
					aria-controls={invitationId}
					id={`${invitationId}-trigger`}
					onClick={() => setInviting(true)}
				>
					<Icon name="plus" size="sm" /> Invite
				</Button>
			</PageHeader>
			{inviting && (
				<InviteForm
					id={invitationId}
					onClose={() => {
						setInviting(false);
						document.getElementById(`${invitationId}-trigger`)?.focus();
					}}
				/>
			)}
			<p
				ref={feedback}
				role="status"
				tabIndex={-1}
				className={notice ? "mb-3 text-xs text-fg-3" : "sr-only"}
			>
				{notice}
			</p>
			<ResourceState
				{...resource}
				retry={resource.refresh}
				label="Loading people"
			/>
			{resource.data && (
				<>
					<div className={tableFrameClass}>
						<table className={tableClasses.compact + " table-fixed"}>
							<caption className="sr-only">Company members</caption>
							<thead>
								<tr className={tableHeadRowClass}>
									<th scope="col" className={tableHeaderCellClass}>
										Member
									</th>
									<th
										scope="col"
										className={
											tableHeaderCellClass + " hidden w-36 sm:table-cell"
										}
									>
										Role
									</th>
									<th
										scope="col"
										className={
											tableHeaderCellClass + " hidden w-32 sm:table-cell"
										}
									>
										Access
									</th>
									<th scope="col" className={tableHeaderCellClass + " w-28"}>
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody className={tableBodyClass}>
								{resource.data.items.map((member) => (
									<MemberRow
										key={member.id}
										member={member}
										onDone={() => {
											setNotice("Member access updated.");
											resource.refresh();
											requestAnimationFrame(() => feedback.current?.focus());
										}}
									/>
								))}
								{!resource.data.items.length && (
									<tr>
										<td colSpan={4} className="px-4 py-6 text-sm text-fg-3">
											No members on this page.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
					<Pagination {...page} nextCursor={resource.data.nextCursor} />
				</>
			)}
			<details className="mt-5">
				<summary className={disclosureSummaryClass}>
					<Icon name="chevronRight" size="xs" />
					What roles and access allow
				</summary>
				<div className="mt-3 grid max-w-[75ch] gap-2 text-sm text-fg-2">
					<p>
						Members can access their own traces. Administrators can access
						company traces, manage people, and change repository policy.
					</p>
					<p>
						Disabling a member removes vault access and revokes their
						collectors, but retains past traces. Enabling access does not
						restore revoked collectors; enroll a new collector when needed.
					</p>
					<p>The last active administrator cannot be disabled.</p>
				</div>
			</details>
		</>
	);
}

function MemberRow({
	member,
	onDone,
}: {
	member: z.infer<typeof membersSchema>["items"][number];
	onDone: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const action = useAction();
	const confirmationId = useId();
	const label = member.disabled ? "Enable" : "Disable";
	return (
		<Fragment>
			<tr className={confirming ? "bg-hover" : "hover:bg-hover"}>
				<td className={tableDenseCellClass + " h-12"}>
					<div className="flex min-w-0 items-center gap-2.5">
						<Avatar name={member.name || member.email} size="md" />
						<div className="min-w-0">
							<p
								className="m-0 truncate font-medium text-fg"
								title={member.name || "Unnamed member"}
							>
								{member.name || "Unnamed member"}
							</p>
							<p
								className="m-0 truncate text-xs text-fg-3"
								title={member.email}
							>
								{member.email}
								<span className="sm:hidden">
									{" · "}
									{member.role === "admin" ? "Admin" : "Member"} ·{" "}
									{member.disabled ? "Disabled" : "Active"}
								</span>
							</p>
						</div>
					</div>
				</td>
				<td className={tableDenseCellClass + " hidden sm:table-cell"}>
					<Badge tone={member.role === "admin" ? "accent" : "neutral"}>
						{member.role === "admin" ? "Admin" : "Member"}
					</Badge>
				</td>
				<td className={tableDenseCellClass + " hidden sm:table-cell"}>
					<StatusText tone={member.disabled ? "neutral" : "ok"}>
						{member.disabled ? "Disabled" : "Active"}
					</StatusText>
				</td>
				<td className={tableDenseCellClass + " text-right"}>
					<Button
						id={`${confirmationId}-trigger`}
						variant="ghost"
						size="sm"
						aria-label={`${label} ${member.name || member.email}`}
						aria-expanded={confirming}
						aria-controls={confirmationId}
						disabled={action.pending}
						onClick={() => setConfirming(!confirming)}
					>
						{label}
					</Button>
				</td>
			</tr>
			{confirming && (
				<tr>
					<td colSpan={4} className="p-0">
						<form
							id={confirmationId}
							className={
								member.disabled
									? "grid gap-2 border-t border-line bg-surface px-4 py-3"
									: "grid gap-2 border-t border-err/20 bg-err/5 px-4 py-3"
							}
							onSubmit={(event) => {
								event.preventDefault();
								void action.run(async () => {
									await api(
										`/api/members/${encodeURIComponent(member.id)}`,
										emptySchema,
										{
											method: "PATCH",
											body: { disabled: !member.disabled },
										},
									);
									setConfirming(false);
									onDone();
								});
							}}
						>
							<p className="text-sm font-medium break-words">
								{label} {member.name || member.email}?
							</p>
							<p className="text-sm text-fg-2">
								{member.disabled
									? "Restores vault access. Previously revoked collectors stay revoked; enroll a new collector when needed."
									: "Removes vault access and revokes this member’s collectors. Past company traces are retained, not deleted."}
							</p>
							<Feedback action={action} />
							<div className="flex flex-wrap gap-1">
								<Button
									variant={member.disabled ? "secondary" : "danger"}
									size="sm"
									type="submit"
									disabled={action.pending}
								>
									{action.pending ? "Saving…" : `${label} member`}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={action.pending}
									onClick={() => {
										setConfirming(false);
										document
											.getElementById(`${confirmationId}-trigger`)
											?.focus();
									}}
								>
									Cancel
								</Button>
							</div>
						</form>
					</td>
				</tr>
			)}
		</Fragment>
	);
}

function InviteForm({ id, onClose }: { id: string; onClose: () => void }) {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState("member");
	const [invitation, setInvitation] = useState<{
		link: string;
		expiresAt: string;
	}>();
	const action = useAction();
	const copy = useAction();
	return (
		<section
			id={id}
			aria-labelledby={`${id}-title`}
			className="mb-6 grid min-w-0 gap-4 rounded-lg border border-line bg-raised p-5 shadow-sm"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 id={`${id}-title`} className="m-0 text-base font-semibold">
						Invite a colleague
					</h2>
					<p className="mt-1 mb-0 max-w-[70ch] text-sm text-fg-3">
						Creates a one-time link, not an email. Send it to the person through
						a private channel you trust.
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Close invitation"
					disabled={action.pending}
					onClick={onClose}
				>
					<Icon name="close" size="sm" />
				</Button>
			</div>
			<form
				className="grid min-w-0 gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void action.run(async () => {
						setInvitation(undefined);
						const result = await api("/api/invitations", invitationSchema, {
							method: "POST",
							body: { email: email.trim(), name: name.trim(), role },
						});
						setInvitation({
							link: `${window.location.origin}/join#${encodeURIComponent(result.invitationToken)}`,
							expiresAt: result.expiresAt,
						});
					});
				}}
			>
				<fieldset
					className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end"
					disabled={action.pending}
				>
					<Field label="Work email">
						<Input
							required
							type="email"
							autoComplete="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</Field>
					<Field label="Display name">
						<Input
							required
							autoComplete="name"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</Field>
					<Field label="Vault role">
						<Select
							value={role}
							onChange={(event) => setRole(event.target.value)}
						>
							<option value="member">Member — own traces</option>
							<option value="admin">Admin — company-wide access</option>
						</Select>
					</Field>
					<Button variant="primary" type="submit" disabled={action.pending}>
						{action.pending ? "Creating…" : "Create invitation"}
					</Button>
				</fieldset>
				<Feedback action={action} />
			</form>
			{invitation && (
				<section
					aria-label="One-time enrollment link"
					className="grid min-w-0 gap-3 border-t border-line-subtle pt-4"
				>
					<Notice tone="warn">
						This private link is held only in this page’s memory. Anyone with it
						can redeem the invitation. Copy it before closing, then deliver it
						to the intended person through a trusted private channel.
					</Notice>
					<Field label="Private enrollment link">
						<Input
							readOnly
							autoComplete="off"
							value={invitation.link}
							onFocus={(event) => event.target.select()}
						/>
					</Field>
					<p className="m-0 text-xs text-fg-3">
						Expires {formatTime(invitation.expiresAt)}. Redeemable once. If
						copying fails, select the link and copy it manually.
					</p>
					<Feedback action={copy} />
					<div className="flex flex-wrap gap-1">
						<Button
							variant="primary"
							size="sm"
							disabled={copy.pending}
							onClick={() => {
								void copy.run(async () => {
									if (!navigator.clipboard)
										throw new Error(
											"Clipboard unavailable. Select the link and copy it manually.",
										);
									await navigator.clipboard.writeText(invitation.link);
								}, "Enrollment link copied.");
							}}
						>
							Copy private link
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setInvitation(undefined)}
						>
							Dismiss link
						</Button>
					</div>
				</section>
			)}
		</section>
	);
}
