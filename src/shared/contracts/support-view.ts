export const supportViewCookieName = "iteration_support_view";

export type SupportViewSession = Readonly<{
	actorSubject: string;
	actorSessionId: string;
	targetUserId: string;
	expiresAt: number;
}>;
