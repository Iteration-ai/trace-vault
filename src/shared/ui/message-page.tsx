import type { ReactNode } from "react";

export function MessagePage({
	brand,
	label,
	title,
	titleId,
	alert = false,
	children,
	actions,
}: Readonly<{
	brand?: ReactNode;
	label?: string;
	title: string;
	titleId: string;
	alert?: boolean;
	children: ReactNode;
	actions?: ReactNode;
}>) {
	return (
		<main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-12 text-fg">
			{brand ? <div className="mb-10">{brand}</div> : null}
			<section aria-labelledby={titleId} role={alert ? "alert" : undefined}>
				{label ? (
					<p className="m-0 text-xs font-medium text-fg-3">{label}</p>
				) : null}
				<h1
					className={
						label
							? "mt-2 mb-0 text-2xl font-semibold"
							: "m-0 text-2xl font-semibold"
					}
					id={titleId}
				>
					{title}
				</h1>
				<div className="mt-3 text-base leading-relaxed text-fg-3">
					{children}
				</div>
				{actions ? (
					<div className="mt-6 flex flex-wrap items-center gap-2">
						{actions}
					</div>
				) : null}
			</section>
		</main>
	);
}
