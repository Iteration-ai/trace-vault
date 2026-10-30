import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./packages/vault/src/schema.ts",
	out: "./packages/vault/migrations",
	schemaFilter: ["vault", "vault_traces"],
});
