import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss from "postcss";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/public", { recursive: true });
await build({
	entryPoints: ["src/main.ts", "src/operator.ts"],
	outdir: "dist",
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	packages: "external",
});
await build({
	entryPoints: ["src/ui-client.tsx"],
	outfile: "dist/public/vault.js",
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	minify: true,
	define: { "process.env.NODE_ENV": '"production"' },
});
const cssPath = new URL("../../src/app/globals.css", import.meta.url);
const css = await postcss([tailwind()]).process(
	`${await readFile(cssPath, "utf8")}\n@source "../shared/ui";\n`,
	{
		from: cssPath.pathname,
	},
);
await writeFile(
	"dist/public/vault.css",
	`${css.css}\n:root { --font-inter: Arial, sans-serif; --font-jetbrains-mono: monospace; }\n`,
);
await cp("migrations", "dist/migrations", { recursive: true });
