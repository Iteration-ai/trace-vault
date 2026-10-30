import type { ReactNode } from "react";

export type PanelPadding = keyof typeof panelPaddingClasses;

const panelPaddingClasses = {
	none: "rounded-lg border border-line bg-surface",
	sm: "rounded-lg border border-line bg-surface p-4",
	md: "rounded-lg border border-line bg-surface p-5 sm:p-6",
} as const;

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
