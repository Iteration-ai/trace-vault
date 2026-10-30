import fs from "node:fs";
import path from "node:path";

const repositoryUrls = new Map<string, string | null>();

function missing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

// A worktree's `.git` is a file pointing at its own git directory, whose
// `commondir` leads to the repository that holds the shared config.
function gitFiles(
	cwd: string,
): Readonly<{ directory: string; config: string }> | null {
	try {
		if (!fs.statSync(cwd).isDirectory()) return null;
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
	for (let directory = cwd; ; directory = path.dirname(directory)) {
		const dotGit = path.join(directory, ".git");
		let stats: fs.Stats;
		try {
			stats = fs.statSync(dotGit);
		} catch (error) {
			if (!missing(error)) throw error;
			if (path.dirname(directory) === directory) return null;
			continue;
		}
		if (stats.isDirectory())
			return { directory: dotGit, config: path.join(dotGit, "config") };
		const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
		if (pointer === null) return null;
		const gitDirectory = path.resolve(directory, pointer[1]!);
		const common = readText(path.join(gitDirectory, "commondir"))?.trim();
		return {
			directory: gitDirectory,
			config: path.join(
				common ? path.resolve(gitDirectory, common) : gitDirectory,
				"config",
			),
		};
	}
}

function originUrl(config: string): string | null {
	let inOrigin = false;
	for (const line of config.split(/\r?\n/)) {
		const section = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
		if (section !== null) {
			inOrigin = /^remote\s+"origin"$/i.test(section[1]!);
			continue;
		}
		const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line) : null;
		if (url !== null) return url[1]!.replace(/^"(.*)"$/, "$1");
	}
	return null;
}

function withoutCredentials(url: string): string {
	return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

// Sources that record only a working directory need the local checkout's
// origin while that checkout still exists.
export function gitRepositoryUrl(cwd: string, refresh = false): string | null {
	if (refresh) repositoryUrls.delete(cwd);
	const known = repositoryUrls.get(cwd);
	if (known !== undefined) return known;
	const files = gitFiles(cwd);
	const config = files === null ? null : readText(files.config);
	const origin = config === null ? null : originUrl(config);
	const url = origin === null ? null : withoutCredentials(origin);
	if (url !== null) repositoryUrls.set(cwd, url);
	return url;
}

export function gitBranch(cwd: string): string | null {
	const files = gitFiles(cwd);
	const head =
		files === null ? null : readText(path.join(files.directory, "HEAD"));
	const branch = /^ref: refs\/heads\/(.+)\s*$/.exec(head ?? "")?.[1];
	return branch ?? null;
}
