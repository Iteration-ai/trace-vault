import { useId, useState } from "react";
import { z } from "zod";
import {
	Button,
	Heading,
	Icon,
	Pagination,
	ResourceState,
	formatTime,
	pageSchema,
	tableBodyClass,
	tableClasses,
	tableDenseCellClass,
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
		createdAt: z.string(),
	}),
);
type AuditRecord = z.infer<typeof auditSchema>["items"][number];

function shortId(id: string, ids: string[]): string {
	if (id.length <= 16) return id;
	let length = 8;
	while (
		length < id.length - 5 &&
		ids.some(
			(other) =>
				other !== id &&
				other.startsWith(id.slice(0, length)) &&
				other.endsWith(id.slice(-4)),
		)
	)
		length++;
	return length >= id.length - 5
		? id
		: `${id.slice(0, length)}…${id.slice(-4)}`;
}

export function Audit() {
	const page = usePage();
	const resource = useResource(`/api/audit${page.query}`, auditSchema);
	const records = resource.data?.items ?? [];
	const recordIds = records.map((record) => record.id);
	const actorIds = records.flatMap((record) =>
		record.actorId === null ? [] : [record.actorId],
	);
	return (
		<>
			<Heading
				title="Audit log"
				description="Recorded administrative and access activity."
			>
				<Button
					variant="ghost"
					size="sm"
					disabled={resource.loading}
					onClick={resource.refresh}
				>
					Refresh
				</Button>
			</Heading>
			<ResourceState {...resource} retry={resource.refresh} />
			{resource.error && page.page > 1 && (
				<Button variant="ghost" size="sm" onClick={page.previous}>
					Previous audit page
				</Button>
			)}
			{resource.data && (
				<>
					{records.length ? (
						<div className="min-w-0 border-y border-line">
							<table
								className={tableClasses.compact + " table-fixed"}
								aria-label="Audit records"
							>
								<colgroup>
									<col />
									<col className="hidden sm:table-column sm:w-1/3 lg:w-64" />
									<col className="w-28 sm:w-44" />
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
											Actor ID
										</th>
										<th scope="col" className={tableHeaderCellClass}>
											Time
										</th>
									</tr>
								</thead>
								<tbody className={tableBodyClass}>
									{records.map((record) => (
										<AuditRow
											key={record.id}
											record={record}
											recordLabel={shortId(record.id, recordIds)}
											actorLabel={
												record.actorId === null
													? "System / not recorded"
													: shortId(record.actorId, actorIds) || "(empty ID)"
											}
										/>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<div className="border-y border-line py-4 text-sm text-fg-3">
							<p>
								{page.page === 1
									? "No audit records yet."
									: "No audit records on this page. Return to the previous page or refresh."}
							</p>
						</div>
					)}
					<Pagination {...page} nextCursor={resource.data.nextCursor} />
				</>
			)}
		</>
	);
}

function AuditRow({
	record,
	recordLabel,
	actorLabel,
}: {
	record: AuditRecord;
	recordLabel: string;
	actorLabel: string;
}) {
	const [open, setOpen] = useState(false);
	const detailId = useId();
	const date = new Date(record.createdAt);
	const validDate = !Number.isNaN(date.getTime());
	return (
		<>
			<tr className="hover:bg-hover focus-within:bg-hover">
				<td className="h-8 min-w-0 px-1.5 py-0 align-middle">
					<Button
						variant="ghost"
						size="sm"
						className="w-full min-w-0 justify-start"
						aria-expanded={open}
						aria-controls={detailId}
						aria-label={`Audit record ${record.id}: ${record.action || "Empty action"}`}
						onClick={() => setOpen((value) => !value)}
					>
						<Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
						<span className="truncate text-fg">
							{record.action || "Empty action"}
						</span>
						<span className="hidden max-w-1/3 shrink-0 truncate font-mono text-2xs text-fg-3 lg:inline">
							{recordLabel}
						</span>
					</Button>
					<p className="truncate px-2.5 pb-1 text-xs text-fg-3 sm:hidden">
						<span className={record.actorId === null ? "" : "font-mono"}>
							{actorLabel}
						</span>
					</p>
				</td>
				<td className={tableDenseCellClass + " hidden sm:table-cell"}>
					<p
						className={
							record.actorId === null
								? "truncate text-fg-3"
								: "truncate font-mono text-xs text-fg-2"
						}
					>
						{actorLabel}
					</p>
				</td>
				<td className={tableDenseCellClass}>
					<time
						dateTime={validDate ? record.createdAt : undefined}
						className="block truncate text-xs text-fg-3 tabular-nums"
					>
						{validDate
							? date.toLocaleDateString(undefined, {
									month: "short",
									day: "numeric",
									year: "2-digit",
								})
							: record.createdAt}
						{validDate && (
							<span className="block sm:inline">
								{" "}
								{date.toLocaleTimeString(undefined, {
									hour: "2-digit",
									minute: "2-digit",
									hour12: false,
								})}
							</span>
						)}
					</time>
				</td>
			</tr>
			<tr id={detailId} hidden={!open}>
				<td colSpan={3} className="px-4 py-3">
					<dl className="grid min-w-0 gap-x-4 gap-y-1 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
						<dt className="text-fg-3">Action</dt>
						<dd className="min-w-0 break-all font-mono">
							{record.action || "(empty string)"}
						</dd>
						<dt className="text-fg-3">Actor ID</dt>
						<dd className="min-w-0 break-all font-mono">
							{record.actorId === null
								? "System / not recorded (null)"
								: record.actorId || "(empty string)"}
						</dd>
						<dt className="text-fg-3">Recorded at</dt>
						<dd className="min-w-0 break-all">
							{formatTime(record.createdAt)}
							<p className="font-mono text-xs text-fg-3">
								{record.createdAt || "(empty string)"}
							</p>
						</dd>
						<dt className="text-fg-3">Record ID</dt>
						<dd className="min-w-0 break-all font-mono">
							{record.id || "(empty string)"}
						</dd>
					</dl>
				</td>
			</tr>
		</>
	);
}
