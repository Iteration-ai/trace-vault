export const segmentedGroupClass =
	"inline-flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5";

export const segmentedItemClasses = {
	selected:
		"inline-flex h-6 items-center rounded-sm bg-selected px-2.5 text-xs font-medium text-fg no-underline inset-ring inset-ring-line focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
	idle: "inline-flex h-6 items-center rounded-sm px-2.5 text-xs text-fg-3 no-underline transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
} as const;
