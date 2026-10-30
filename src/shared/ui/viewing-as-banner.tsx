import type { ReactNode } from "react";
import { Icon } from "./icon";

export function ViewingAsBanner({
	identity,
	detail,
	action,
}: Readonly<{ identity: string; detail?: ReactNode; action: ReactNode }>) {
	return (
		<div className="sticky top-0 z-50 flex min-h-10 items-center justify-between gap-3 border-b border-warn/30 bg-[color-mix(in_oklab,var(--color-warn)_8%,var(--color-canvas))] px-4 py-1.5 text-xs text-fg sm:px-6">
			<p className="m-0 flex min-w-0 items-center gap-2" role="status">
				<Icon className="text-warn" name="view" size="sm" />
				<span className="shrink-0 font-semibold text-warn">Viewing as</span>
				<span className="truncate" title={identity}>
					{identity}
				</span>
				{detail}
			</p>
			{action}
		</div>
	);
}
