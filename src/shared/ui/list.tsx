import type { ReactNode } from "react";

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
