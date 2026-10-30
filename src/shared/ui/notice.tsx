import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

const noticeTones = ["ok", "err", "warn", "neutral"] as const;
export type NoticeTone = (typeof noticeTones)[number];

const noticeToneClasses = {
	ok: "border-ok/25 bg-ok/10 text-fg",
	err: "border-err/30 bg-err/10 text-fg",
	warn: "border-warn/25 bg-warn/10 text-fg",
	neutral: "border-line bg-raised text-fg-2",
} as const satisfies Record<NoticeTone, string>;

const noticeIconClasses = {
	ok: "mt-0.5 text-ok",
	err: "mt-0.5 text-err",
	warn: "mt-0.5 text-warn",
	neutral: "mt-0.5 text-fg-3",
} as const satisfies Record<NoticeTone, string>;

const noticeIcons = {
	ok: "success",
	err: "alert",
	warn: "alert",
	neutral: "alert",
} as const satisfies Record<NoticeTone, IconName>;

export function Notice({
	tone,
	children,
}: Readonly<{ tone: NoticeTone; children: ReactNode }>) {
	return (
		<div
			className={
				"m-0 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm " +
				noticeToneClasses[tone]
			}
			role={tone === "err" ? "alert" : "status"}
		>
			<Icon className={noticeIconClasses[tone]} name={noticeIcons[tone]} />
			<div className="min-w-0">{children}</div>
		</div>
	);
}
