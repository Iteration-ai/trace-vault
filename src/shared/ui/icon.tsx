import {
	Activity,
	Brain,
	CalendarRange,
	ChartColumnStacked,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	ArrowUpRight,
	Check,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	ChevronsUpDown,
	Copy,
	CornerDownRight,
	CircleAlert,
	CircleCheck,
	CircleDashed,
	CircleDollarSign,
	Ellipsis,
	Eye,
	FileText,
	Folder,
	FolderGit2,
	GitPullRequest,
	Image,
	Inbox,
	Info,
	Laptop,
	LayoutDashboard,
	Link2,
	ListChecks,
	ListFilter,
	MessagesSquare,
	Minus,
	PanelLeft,
	Pencil,
	Plus,
	Repeat2,
	Search,
	Settings,
	Sparkles,
	Terminal,
	Trash2,
	Users,
	Wrench,
	X,
} from "lucide-react";

const icons = {
	friction: Activity,
	arrowDown: ArrowDown,
	arrowLeft: ArrowLeft,
	arrowRight: ArrowRight,
	arrowUp: ArrowUp,
	arrowUpRight: ArrowUpRight,
	calendar: CalendarRange,
	chart: ChartColumnStacked,
	check: Check,
	close: X,
	chevronDown: ChevronDown,
	chevronRight: ChevronRight,
	chevronUp: ChevronUp,
	chevronsUpDown: ChevronsUpDown,
	copy: Copy,
	edit: Pencil,
	link: Link2,
	more: Ellipsis,
	panel: PanelLeft,
	plan: ListChecks,
	pullRequest: GitPullRequest,
	thought: Brain,
	tool: Wrench,
	cost: CircleDollarSign,
	nested: CornerDownRight,
	alert: CircleAlert,
	success: CircleCheck,
	pending: CircleDashed,
	file: FileText,
	folder: Folder,
	image: Image,
	repository: FolderGit2,
	view: Eye,
	inbox: Inbox,
	info: Info,
	overview: LayoutDashboard,
	collectors: Laptop,
	filter: ListFilter,
	sessions: MessagesSquare,
	plus: Plus,
	minus: Minus,
	suggestion: Sparkles,
	pattern: Repeat2,
	search: Search,
	settings: Settings,
	terminal: Terminal,
	trash: Trash2,
	users: Users,
} as const;

export type IconName = keyof typeof icons;

const iconSizes = ["xs", "sm", "md", "lg"] as const;
export type IconSize = (typeof iconSizes)[number];

const iconPixels = {
	xs: 12,
	sm: 14,
	md: 16,
	lg: 20,
} as const satisfies Record<IconSize, number>;

export function Icon({
	name,
	size = "md",
	className,
}: Readonly<{ name: IconName; size?: IconSize; className?: string }>) {
	const Glyph = icons[name];
	return (
		<Glyph
			aria-hidden="true"
			className={className ? "shrink-0 " + className : "shrink-0"}
			focusable="false"
			size={iconPixels[size]}
			strokeWidth={1.75}
		/>
	);
}
