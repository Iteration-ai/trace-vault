// The kind of change a drafted fix makes to the agent setup. Friction
// problems and cost findings draft the same kinds of fix.
export type FixKind = "instruction" | "check" | "context" | "tool";

export const FIX_KIND_LABELS = {
	instruction: "Instruction",
	check: "Check",
	context: "Context",
	tool: "Tool",
} as const satisfies Record<FixKind, string>;
