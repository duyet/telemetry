import { randomHex } from "./util.ts";

export const SCHEMA_VERSION = 1;

/** Idempotent schema. The Worker applies it itself so `cf deploy` is the whole install. */
const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS projects (
		slug TEXT PRIMARY KEY, name TEXT, description TEXT, homepage TEXT,
		admin_hash TEXT NOT NULL, created_at TEXT NOT NULL, creator TEXT
	) WITHOUT ROWID`,
	`CREATE TABLE IF NOT EXISTS daily (
		project TEXT NOT NULL, day TEXT NOT NULL,
		dau INTEGER NOT NULL, wau INTEGER NOT NULL, mau INTEGER NOT NULL, events INTEGER NOT NULL,
		dims TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'ae',
		PRIMARY KEY (project, day)
	) WITHOUT ROWID`,
];

let ready: Promise<void> | undefined;
let salt: string | undefined;

/** Applies the schema once per isolate and loads (or creates) the server salt. */
export function ensureReady(db: D1Database): Promise<void> {
	ready ??= (async () => {
		const row = await db
			.prepare("SELECT v FROM meta WHERE k = 'schema_version'")
			.first<{ v: string }>()
			.catch(() => null);
		if (Number(row?.v) !== SCHEMA_VERSION) {
			await db.batch([
				...SCHEMA.map((s) => db.prepare(s)),
				db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)").bind(String(SCHEMA_VERSION)),
				db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('salt', ?)").bind(randomHex(32)),
			]);
		}
		const s = await db.prepare("SELECT v FROM meta WHERE k = 'salt'").first<{ v: string }>();
		if (!s) throw new Error("salt missing after schema init");
		salt = s.v;
	})().catch((err) => {
		ready = undefined;
		throw err;
	});
	return ready;
}

/** Server salt for uid hashing. Call after ensureReady. */
export function getSalt(): string {
	if (!salt) throw new Error("ensureReady not awaited");
	return salt;
}

const PROJECT_TTL_MS = 5 * 60_000;
const MISS_REFRESH_MS = 30_000;
let projects: Set<string> | undefined;
let loadedAt = 0;

async function loadProjects(db: D1Database): Promise<void> {
	const { results } = await db.prepare("SELECT slug FROM projects").all<{ slug: string }>();
	projects = new Set(results.map((r) => r.slug));
	loadedAt = Date.now();
}

/**
 * Answers from isolate memory so ingest costs no D1 reads. A miss refreshes at most
 * once per 30s, so a project created on another isolate shows up quickly while a
 * flood of unknown slugs costs almost nothing.
 */
export async function projectExists(db: D1Database, slug: string): Promise<boolean> {
	const age = Date.now() - loadedAt;
	if (!projects || age > PROJECT_TTL_MS) await loadProjects(db);
	else if (!projects.has(slug) && age > MISS_REFRESH_MS) await loadProjects(db);
	return projects!.has(slug);
}

/** Call after create/delete on this isolate. */
export function rememberProject(slug: string, exists: boolean): void {
	if (!projects) return;
	if (exists) projects.add(slug);
	else projects.delete(slug);
}

/** Test hook: reset isolate state. */
export function resetDbState(): void {
	ready = undefined;
	salt = undefined;
	projects = undefined;
	loadedAt = 0;
}
