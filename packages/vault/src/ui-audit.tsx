import { useId, useState } from "react";
import { z } from "zod";
import {
	Button,
	EmptyState,
	Icon,
	PageHeader,
	Pagination,
	Person,
	RelativeTime,
	ResourceState,
	formatTime,
	pageSchema,
	tableBodyClass,
	tableClasses,
	tableDenseCellClass,
	tableFrameClass,
	tableHeaderCellClass,
	tableHeadRowClass,
	usePage,
	useResource,
} from "./ui-common";

const auditSchema = pageSchema(
	z.object({
		id: z.string(),
		action: z.string(),
		actorId: z.string().nullable(),
		actorName: z.string().nullable(),
		targetId: z.string(),
		createdAt: z.string(),
	}),
);
type AuditRecord = z.infer<typeof auditSchema>["items"][number];

const actionLabels: Record<string, string> = {
	"company.initialized": "Vault created",
	"admin.password_recovered": "Administrator password recovered",
	"member.updated": "Member access changed",
	"invitation.created": "Invitation created",
	"invitation.revoked": "Invitation revoked",
	"invitation.redeemed": "Invitation accepted",
	"device.enrolled": "Collector enrolled",
	"device.revoked": "Collector revoked",
	"policy.member_updated": "Collection rules changed",
	"policy.repositories_updated": "Repositories changed",
	"session.deleted": "Session deleted",
};

// Unknown actions from newer servers stay readable as their stored name.
function actionLabel(action: string): string {
	return Object.hasOwn(actionLabels, action)
		? actionLabels[action]!
		: action || "Empty action";
}

export function Audit() {
	const page = usePage();
	const resource = useResource(`/api/audit${page.query}`, auditSchema);
	const records = resource.data?.items ?? [];
	return (
		<>
			<PageHeader
				title="Audit log"
				description="Administrative and access changes, newest first"
			>
				<Button
					variant="secondary"
					disabled={resource.loading}
					onClick={resource.refresh}
				>
					Refresh
				</Button>
			</PageHeader>
			<ResourceState
				{...resource}
				retry={resource.refresh}
				label="Loading audit records"
			/>
			{resource.error && page.page > 1 && (
				<Button variant="ghost" size="sm" onClick={page.previous}>
					Previous audit page
				</Button>
			)}
			{resource.data && (
				<>
					{records.length ? (
						<div className={tableFrameClass}>
							<table
								className={tableClasses.compact + " table-fixed"}
								aria-label="Audit records"
							>
								<colgroup>
									<col />
									<col className="hidden sm:table-column sm:w-1/4 lg:w-60" />
									<col className="w-28 sm:w-36" />
								</colgroup>
								<thead>
									<tr className={tableHeadRowClass}>
										<th scope="col" className={tableHeaderCellClass}>
											Action
										</th>
										<th
											scope="col"
											className={tableHeaderCellClass + " hidden sm:table-cell"}
										>
											By
										</th>
										<th scope="col" className={tableHeaderCellClass}>
											When
										</th>
									</tr>
								</thead>
								<tbody className={tableBodyClass}>
									{records.map((record) => (
										<AuditRow key={record.id} record={record} />
									))}
								</tbody>
							</table>
						</div>
					) : (
						<EmptyState
							title={
								page.page === 1
									? "No audit records yet"
									: "No audit records on this page"
							}
						>
							{page.page === 1
								? "Invitations, member access, collectors and rule changes appear here."
								: "Return to the previous page or refresh."}
						</EmptyState>
					)}
					<Pagination {...page} nextCursor={resource.data.nextCursor} />
				</>
			)}
		</>
	);
}

function AuditRow({ record }: { record: AuditRecord }) {
	const [open, setOpen] = useState(false);
	const detailId = useId();
	const actor =
		record.actorId === null ? "System" : record.actorName || "Unknown member";
	return (
		<>
			<tr className={open ? "bg-hover" : "hover:bg-hover"}>
				<td className="h-10 min-w-0 px-1.5 py-0 align-middle">
					<Button
						variant="ghost"
						size="sm"
						className="w-full min-w-0 justify-start text-fg hover:bg-transparent"
						aria-expanded={open}
						aria-controls={detailId}
						aria-label={`Audit record: ${actionLabel(record.action)} by ${actor}`}
						onClick={() => setOpen((value) => !value)}
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
						<span className="truncate">{actionLabel(record.action)}</span>
						<span className="truncate text-xs font-normal text-fg-3 sm:hidden">
							{actor}
						</span>
					</Button>
				</td>
				<td className={tableDenseCellClass + " hidden text-xs sm:table-cell"}>
					{record.actorId === null ? (
						<span className="text-fg-3">System</span>
					) : (
						<span title={`Member ID ${record.actorId}`}>
							<Person name={record.actorName ?? ""} />
						</span>
					)}
				</td>
				<td className={tableDenseCellClass + " text-xs text-fg-3 tabular-nums"}>
					<RelativeTime value={record.createdAt} />
				</td>
			</tr>
			<tr id={detailId} hidden={!open} className="bg-surface">
				<td colSpan={3} className="px-4 py-3 sm:pl-10">
					<dl className="m-0 grid min-w-0 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
						<dt className="text-fg-3">Recorded at</dt>
						<dd className="m-0 min-w-0 break-all text-fg-2">
							{formatTime(record.createdAt)}
						</dd>
						<dt className="text-fg-3">Action</dt>
						<dd className="m-0 min-w-0 font-mono break-all text-fg-2">
							{record.action || "(empty string)"}
						</dd>
						<dt className="text-fg-3">Target ID</dt>
						<dd className="m-0 min-w-0 font-mono break-all text-fg-2">
							{record.targetId || "(empty string)"}
						</dd>
						<dt className="text-fg-3">Actor ID</dt>
						<dd className="m-0 min-w-0 font-mono break-all text-fg-2">
							{record.actorId ?? "None (system)"}
						</dd>
						<dt className="text-fg-3">Record ID</dt>
						<dd className="m-0 min-w-0 font-mono break-all text-fg-2">
							{record.id}
						</dd>
					</dl>
				</td>
			</tr>
		</>
	);
}
