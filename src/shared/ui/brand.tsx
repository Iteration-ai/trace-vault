export const brandSizes = ["sm", "md"] as const;
export type BrandSize = (typeof brandSizes)[number];

const brandMarkClasses = {
	sm: "size-5 shrink-0",
	md: "size-6 shrink-0",
} as const satisfies Record<BrandSize, string>;

const brandWordClasses = {
	sm: "text-sm font-semibold",
	md: "text-md font-semibold",
} as const satisfies Record<BrandSize, string>;

type Dot = Readonly<{ x: number; y: number; radius: number }>;

const lightLength = Math.hypot(-0.4, -0.48, 0.78);
const light = [
	-0.4 / lightLength,
	-0.48 / lightLength,
	0.78 / lightLength,
] as const;

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

// Darkness of a sphere lit from the upper left, like the marketing hero's
// halftone sphere: 0 in the highlight, 1 in the shadow.
function shade(x: number, y: number): number {
	const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
	const lit = Math.max(0, x * light[0] + y * light[1] + z * light[2]);
	return Math.max(0, (0.95 - lit) / 0.95);
}

function sphereDots(rings: number, smallest: number, largest: number) {
	const step = 50 / (rings + largest);
	const dots: Dot[] = [];
	for (let ring = 0; ring <= rings; ring++) {
		const count = ring === 0 ? 1 : Math.round(2 * Math.PI * ring);
		const phase = ring % 2 === 1 ? Math.PI / count : 0;
		for (let index = 0; index < count; index++) {
			const angle = phase + (2 * Math.PI * index) / count - Math.PI / 2;
			const x = ring * step * Math.cos(angle);
			const y = ring * step * Math.sin(angle);
			const radius =
				step * (smallest + (largest - smallest) * shade(x / 50, y / 50));
			dots.push({ x: round(50 + x), y: round(50 + y), radius: round(radius) });
		}
	}
	return dots;
}

// Three rings keep each dot large enough to read at icon sizes.
const markDots = sphereDots(3, 0.14, 0.48);

export function BrandMark({ size = "md" }: Readonly<{ size?: BrandSize }>) {
	return (
		<svg
			aria-hidden="true"
			className={brandMarkClasses[size]}
			fill="currentColor"
			viewBox="0 0 100 100"
		>
			{markDots.map((dot) => (
				<circle
					cx={dot.x}
					cy={dot.y}
					key={dot.x + "," + dot.y}
					r={dot.radius}
				/>
			))}
		</svg>
	);
}

export function BrandLockup({ size = "md" }: Readonly<{ size?: BrandSize }>) {
	return (
		<span className="inline-flex items-center gap-2 text-fg">
			<BrandMark size={size} />
			<span className={brandWordClasses[size]}>Iteration</span>
		</span>
	);
}
