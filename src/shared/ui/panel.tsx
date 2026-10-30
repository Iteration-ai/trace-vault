import type { ReactNode } from "react";

export const panelPaddings = ["none", "sm", "md"] as const;
export type PanelPadding = (typeof panelPaddings)[number];

const panelPaddingClasses = {
	none: "rounded-lg border border-line bg-surface",
	sm: "rounded-lg border border-line bg-surface p-4",
	md: "rounded-lg border border-line bg-surface p-5 sm:p-6",
} as const satisfies Record<PanelPadding, string>;

export const popoverClasses = {
	menu: "rounded-lg border border-line-strong bg-overlay p-1 shadow-md",
	content: "rounded-lg border border-line-strong bg-overlay p-4 shadow-md",
} as const;

export const codeBlockClass =
	"block max-w-full overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-fg-2";

export function Panel({
	padding = "md",
	labelledBy,
	children,
}: Readonly<{
	padding?: PanelPadding;
	labelledBy?: string;
	children: ReactNode;
}>) {
	return labelledBy ? (
		<section
			aria-labelledby={labelledBy}
			className={panelPaddingClasses[padding]}
		>
			{children}
		</section>
	) : (
		<div className={panelPaddingClasses[padding]}>{children}</div>
	);
}
