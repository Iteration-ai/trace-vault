export const filterChipClasses = {
	group:
		"inline-flex h-7 max-w-full min-w-0 items-stretch overflow-hidden rounded-md border border-line-strong bg-raised text-xs text-fg-2",
	property: "inline-flex shrink-0 items-center gap-1.5 px-2 text-fg-3",
	detail:
		"inline-flex min-w-0 items-center border-l border-line px-2 text-fg-2",
	segment:
		"inline-flex min-w-0 items-center gap-1 border-l border-line px-2 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
	value:
		"inline-flex min-w-0 items-center gap-1 border-l border-line px-2 font-medium text-fg transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
	remove:
		"grid w-7 shrink-0 place-items-center border-l border-line text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
} as const;

export const menuOptionClass =
	"flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-fg-2 transition-colors hover:bg-hover hover:text-fg data-[active=true]:bg-hover data-[active=true]:text-fg";

export const menuCheckClasses = {
	checked:
		"grid size-4 shrink-0 place-items-center rounded-sm border border-accent bg-accent text-primary-fg",
	unchecked:
		"grid size-4 shrink-0 place-items-center rounded-sm border border-line-strong",
} as const;
