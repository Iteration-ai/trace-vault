import type { ReactNode } from "react";

export const tones = [
	"neutral",
	"accent",
	"ok",
	"warn",
	"err",
	"info",
] as const;
export type Tone = (typeof tones)[number];

const badgeToneClasses = {
	neutral: "border-line-strong text-fg-3",
	accent: "border-accent/30 bg-accent/10 text-accent",
	ok: "border-ok/25 bg-ok/10 text-ok",
	warn: "border-warn/25 bg-warn/10 text-warn",
	err: "border-err/30 bg-err/10 text-err",
	info: "border-info/25 bg-info/10 text-info",
} as const satisfies Record<Tone, string>;

const statusDotToneClasses = {
	neutral: "bg-fg-4",
	accent: "bg-accent",
	ok: "bg-ok",
	warn: "bg-warn",
	err: "bg-err",
	info: "bg-info",
} as const satisfies Record<Tone, string>;

export function Badge({
	tone = "neutral",
	dot = false,
	children,
}: Readonly<{ tone?: Tone; dot?: boolean; children: ReactNode }>) {
	return (
		<span
			className={
				"inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-2xs font-medium whitespace-nowrap " +
				badgeToneClasses[tone]
			}
		>
			{dot ? <StatusDot tone={tone} /> : null}
			{children}
		</span>
	);
}

function StatusDot({ tone }: Readonly<{ tone: Tone }>) {
	return (
		<span
			aria-hidden="true"
			className={"size-1.5 shrink-0 rounded-full " + statusDotToneClasses[tone]}
		/>
	);
}

export function Kbd({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<kbd className="inline-grid h-5 min-w-5 place-items-center rounded-sm border border-line-strong bg-raised px-1 text-2xs text-fg-2">
			{children}
		</kbd>
	);
}
