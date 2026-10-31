import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export async function buildCollectorBundles(entries) {
	await rm("dist", { recursive: true, force: true });
	const result = await build({
		entryPoints: entries,
		outdir: "dist",
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		legalComments: "eof",
		logLevel: "warning",
		metafile: true,
		banner: {
			js: 'import { createRequire as collectorCreateRequire } from "node:module"; const require = collectorCreateRequire(import.meta.url);',
		},
	});

	const packages = new Set();
	for (const input of Object.keys(result.metafile.inputs)) {
		if (!input.includes("node_modules/")) {
			const canonicalRoot = fileURLToPath(new URL("..", import.meta.url));
			const relative = path
				.relative(canonicalRoot, path.resolve(input))
				.split(path.sep)
				.join("/");
			if (!/^(cli|trace-contracts)\//.test(relative))
				throw new Error(
					`Collector bundle imports noncanonical source: ${input}`,
				);
			continue;
		}
		let directory = path.dirname(path.resolve(input));
		while (directory !== path.dirname(directory)) {
			try {
				const manifest = JSON.parse(
					await readFile(path.join(directory, "package.json"), "utf8"),
				);
				if (
					typeof manifest.name === "string" &&
					typeof manifest.version === "string"
				) {
					packages.add(directory);
					break;
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			directory = path.dirname(directory);
		}
	}
	const notices = [];
	for (const directory of [...packages].sort()) {
		const manifest = JSON.parse(
			await readFile(path.join(directory, "package.json"), "utf8"),
		);
		notices.push(
			`\n## ${manifest.name}@${manifest.version} (${manifest.license ?? "see license below"})\n`,
		);
		for (const name of (await readdir(directory)).sort()) {
			if (/^(licen[cs]e|copying|notice)(\.|$)/i.test(name)) {
				notices.push(
					`\n### ${name}\n\n${await readFile(path.join(directory, name), "utf8")}\n`,
				);
			}
		}
	}
	await writeFile("dist/THIRD-PARTY-NOTICES.txt", notices.join("\n"));
	await Promise.all([
		copyFile("LICENSE", "dist/LICENSE"),
		copyFile("NOTICE", "dist/NOTICE"),
		copyFile("../../OPEN-SOURCE.md", "dist/OPEN-SOURCE.md"),
	]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	await buildCollectorBundles(["src/index.ts"]);
}
