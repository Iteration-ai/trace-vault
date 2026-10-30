import { useId } from "react";

const trendLineToneClasses = {
	accent: "stroke-accent",
	"chart-1": "stroke-chart-1",
	"chart-2": "stroke-chart-2",
	"chart-3": "stroke-chart-3",
	"chart-4": "stroke-chart-4",
	"chart-5": "stroke-chart-5",
} as const;

export const trendLineTones = Object.keys(
	trendLineToneClasses,
) as (keyof typeof trendLineToneClasses)[];

// A line through evenly spaced values with a soft area beneath it. It fills
// its positioned container; a null value breaks the line.
export function TrendLine({
	values,
	max,
	tone,
}: Readonly<{
	values: readonly (number | null)[];
	max: number;
	tone: keyof typeof trendLineToneClasses;
}>) {
	const gradient = useId();
	const last = values.length - 1;
	const x = (index: number) => (last <= 0 ? 50 : (index / last) * 100);
	const y = (value: number) => 100 - (Math.min(value, max) / max) * 100;
	const runs: { index: number; value: number }[][] = [[]];
	values.forEach((value, index) => {
		if (value === null) runs.push([]);
		else runs.at(-1)?.push({ index, value });
	});
	return (
		<svg
			aria-hidden="true"
			className="absolute inset-0 size-full overflow-visible"
			preserveAspectRatio="none"
			viewBox="0 0 100 100"
		>
			<defs>
				<linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
					<stop
						offset="0"
						style={{ stopColor: `var(--color-${tone})`, stopOpacity: 0.22 }}
					/>
					<stop
						offset="1"
						style={{ stopColor: `var(--color-${tone})`, stopOpacity: 0 }}
					/>
				</linearGradient>
			</defs>
			{runs.map((run) => {
				const start = run[0];
				const end = run.at(-1);
				if (start === undefined || end === undefined) return null;
				const points = run
					.map((point) => `${x(point.index)},${y(point.value)}`)
					.join(" ");
				return (
					<g key={start.index}>
						<polygon
							fill={`url(#${gradient})`}
							points={`${x(start.index)},100 ${points} ${x(end.index)},100`}
						/>
						<polyline
							className={`fill-none ${trendLineToneClasses[tone]}`}
							points={points}
							strokeLinejoin="round"
							strokeWidth="2"
							vectorEffect="non-scaling-stroke"
						/>
					</g>
				);
			})}
		</svg>
	);
}
