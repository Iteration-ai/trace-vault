import type {
	InputHTMLAttributes,
	ReactNode,
	Ref,
	SelectHTMLAttributes,
	TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./icon";

export const fieldSizes = ["md", "lg"] as const;
export type FieldSize = (typeof fieldSizes)[number];

const controlBaseClass =
	"block w-full min-w-0 rounded-md border border-line-strong bg-surface text-fg transition-colors placeholder:text-fg-3 hover:border-fg-4 focus:border-accent focus:ring-2 focus:ring-accent/25 focus:outline-none disabled:opacity-50";

const controlSizeClasses = {
	md: "h-8 px-2.5 text-sm",
	lg: "h-11 px-3.5 text-md",
} as const satisfies Record<FieldSize, string>;

export const fieldLabelClass = "grid gap-1.5 text-xs font-medium text-fg-2";

const controlWithIconSizeClasses = {
	md: "h-8 pr-2.5 pl-8 text-sm",
	lg: "h-11 pr-3.5 pl-10 text-md",
} as const satisfies Record<FieldSize, string>;

const controlIconClasses = {
	md: "pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-3",
	lg: "pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-fg-3",
} as const satisfies Record<FieldSize, string>;

function inputClasses(size: FieldSize = "md"): string {
	return controlBaseClass + " " + controlSizeClasses[size];
}

export function Input({
	size = "md",
	icon,
	className,
	...props
}: Readonly<
	Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
		size?: FieldSize;
		icon?: IconName;
		ref?: Ref<HTMLInputElement>;
	}
>) {
	if (icon) {
		return (
			<span
				className={className ? "relative block " + className : "relative block"}
			>
				<Icon className={controlIconClasses[size]} name={icon} size="sm" />
				<input
					className={controlBaseClass + " " + controlWithIconSizeClasses[size]}
					{...props}
				/>
			</span>
		);
	}
	return (
		<input
			className={
				className ? inputClasses(size) + " " + className : inputClasses(size)
			}
			{...props}
		/>
	);
}

export function Textarea({
	className,
	...props
}: Readonly<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
	const textareaClass = controlBaseClass + " min-h-24 px-3.5 py-3 text-md";
	return (
		<textarea
			className={className ? textareaClass + " " + className : textareaClass}
			{...props}
		/>
	);
}

export function Select({
	size = "md",
	children,
	...props
}: Readonly<
	Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "className"> & {
		size?: FieldSize;
		children: ReactNode;
	}
>) {
	return (
		<span className="relative block min-w-0">
			<select
				className={inputClasses(size) + " appearance-none pr-8"}
				{...props}
			>
				{children}
			</select>
			<Icon
				className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-3"
				name="chevronDown"
				size="sm"
			/>
		</span>
	);
}
