import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as z from "zod";

export const passwordSchema = z.string().min(12).max(256);

const derive = promisify<string, string, number, Buffer>(scrypt);
const storedPasswordSchema = z
	.string()
	.regex(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);

export function secretHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function newSecret(kind: "session" | "device" | "invitation"): string {
	const prefixes = { session: "vs", device: "vd", invitation: "vi" };
	return `${prefixes[kind]}_${randomBytes(32).toString("base64url")}`;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16).toString("hex");
	const key = await derive(password, salt, 64);
	return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const valid = storedPasswordSchema.safeParse(stored);
	const [, salt, expected] = valid.success
		? valid.data.split("$")
		: ["scrypt", "00000000000000000000000000000000", "0".repeat(128)];
	const actual = await derive(password, salt!, 64);
	return (
		timingSafeEqual(actual, Buffer.from(expected!, "hex")) && valid.success
	);
}
