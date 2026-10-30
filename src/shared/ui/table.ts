export const tableClasses = {
	compact: "w-full border-collapse text-left",
	regular: "w-full min-w-[760px] border-collapse text-left",
	wide: "w-full min-w-[1040px] border-collapse text-left",
} as const;

export const tableHeadRowClass =
	"border-b border-line text-xs font-medium text-fg-3";

export const tableHeaderCellClass = "h-9 px-4 font-medium";

export const tableBodyClass = "divide-y divide-line-subtle";

export const tableDenseCellClass =
	"h-8 px-4 py-0 align-middle text-sm whitespace-nowrap";
