import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = keyof typeof buttonVariantClasses;
export type ButtonSize = keyof typeof buttonSizeClasses;

const buttonBaseClass =
	"inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap no-underline transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50";

const buttonVariantClasses = {
	primary: "bg-primary text-primary-fg shadow-sm hover:bg-primary-hover",
	secondary:
		"border border-line-strong bg-raised text-fg shadow-sm hover:border-fg-4 hover:bg-overlay",
	ghost: "text-fg-2 hover:bg-hover hover:text-fg",
	danger: "border border-err/35 text-err hover:bg-err/10",
} as const;

const buttonSizeClasses = {
	sm: "h-7 px-2.5 text-sm",
	md: "h-8 px-3 text-sm",
	lg: "h-10 px-4 text-base",
	icon: "size-8 text-sm",
} as const;

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
