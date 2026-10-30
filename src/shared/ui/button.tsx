import type { ButtonHTMLAttributes } from "react";
import { Icon } from "./icon";

export const buttonVariants = [
	"primary",
	"secondary",
	"ghost",
	"danger",
] as const;
export type ButtonVariant = (typeof buttonVariants)[number];

export const buttonSizes = ["sm", "md", "lg", "icon"] as const;
export type ButtonSize = (typeof buttonSizes)[number];

const buttonBaseClass =
	"inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap no-underline transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

const buttonVariantClasses = {
	primary: "bg-primary text-primary-fg shadow-sm hover:bg-primary-hover",
	secondary:
		"border border-line-strong bg-raised text-fg shadow-sm hover:border-fg-4 hover:bg-overlay",
	ghost: "text-fg-2 hover:bg-hover hover:text-fg",
	danger: "border border-err/35 text-err hover:bg-err/10",
} as const satisfies Record<ButtonVariant, string>;

const buttonSizeClasses = {
	sm: "h-7 px-2.5 text-sm",
	md: "h-8 px-3 text-sm",
	lg: "h-10 px-4 text-base",
	icon: "size-8 text-sm",
} as const satisfies Record<ButtonSize, string>;

export function buttonClasses(
	variant: ButtonVariant,
	size: ButtonSize = "md",
): string {
	return (
		buttonBaseClass +
		" " +
		buttonVariantClasses[variant] +
		" " +
		buttonSizeClasses[size]
	);
}

export const ctaSizes = ["md", "lg"] as const;
export type CtaSize = (typeof ctaSizes)[number];

const ctaBaseClass =
	"group/cta inline-flex shrink-0 items-center bg-primary font-medium whitespace-nowrap text-primary-fg no-underline shadow-light-md transition-colors duration-150 hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const ctaSizeClasses = {
	md: "h-9.5 gap-3 rounded-xl pr-1.25 pl-4 text-sm",
	lg: "h-12 gap-3.5 rounded-2xl pr-1.5 pl-5 text-md",
} as const satisfies Record<CtaSize, string>;

const ctaArrowClasses = {
	md: "grid size-7 place-items-center rounded-md bg-primary-fg/12 ring-1 ring-primary-fg/10 ring-inset",
	lg: "grid size-9 place-items-center rounded-lg bg-primary-fg/12 ring-1 ring-primary-fg/10 ring-inset",
} as const satisfies Record<CtaSize, string>;

// The marketing call to action: a primary link that ends in an arrow tile.
export function ctaClasses(size: CtaSize): string {
	return ctaBaseClass + " " + ctaSizeClasses[size];
}

export function CtaArrow({ size }: Readonly<{ size: CtaSize }>) {
	return (
		<span aria-hidden="true" className={ctaArrowClasses[size]}>
			<Icon
				className="transition-transform duration-150 group-hover/cta:translate-x-0.5"
				name="arrowRight"
				size={size === "lg" ? "md" : "sm"}
			/>
		</span>
	);
}

export function Button({
	variant,
	size = "md",
	type = "button",
	className,
	...props
}: Readonly<
	ButtonHTMLAttributes<HTMLButtonElement> & {
		variant: ButtonVariant;
		size?: ButtonSize;
	}
>) {
	return (
		<button
			className={
				className
					? buttonClasses(variant, size) + " " + className
					: buttonClasses(variant, size)
			}
			type={type}
			{...props}
		/>
	);
}
