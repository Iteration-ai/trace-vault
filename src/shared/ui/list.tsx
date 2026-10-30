import type { ReactNode } from "react";

export const listRowLinkClass =
	"group flex min-w-0 items-center gap-3 px-4 py-2.5 text-fg no-underline transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent";

export function List({
	label,
	children,
}: Readonly<{ label?: string; children: ReactNode }>) {
	return (
		<ul
			aria-label={label}
			className="m-0 list-none divide-y divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface p-0"
		>
			{children}
		</ul>
	);
}
