export const textLinkClass =
	"rounded-sm text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-fg-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const mutedTextLinkClass =
	"rounded-sm text-fg-2 underline decoration-line underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const quietLinkClasses = {
	inherit:
		"inline-flex items-center gap-1 rounded-sm font-medium text-fg-2 no-underline transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
	xs: "inline-flex items-center gap-1 rounded-sm text-xs font-medium text-fg-2 no-underline transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
	sm: "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-fg-2 no-underline transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
} as const;
