export type AuthenticatedUserIdentity = Readonly<{
	provider: "clerk";
	subject: string;
	email: string;
	displayName: string;
}>;
