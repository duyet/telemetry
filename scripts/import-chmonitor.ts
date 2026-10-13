/**
 * One-off backfill: old chmonitor telemetry D1 -> rollups -> POST /api/<project>/import.
 * Read only on the source: this script runs SELECT and PRAGMA, nothing else.
 *
 *   CLOUDFLARE_ACCOUNT_ID=<account> bun scripts/import-chmonitor.ts --db <d1-uuid>                       # dry run
 *   CLOUDFLARE_ACCOUNT_ID=<account> TELEMETRY_ADMIN_TOKEN=tk_... \
 *     bun scripts/import-chmonitor.ts --db <d1-uuid> --base <url> --project chmonitor --apply
 *
 * Needs the `cf` CLI authenticated for the account (run through npx, Node >= 22.18).
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { postRollups, printRollups, type RawRow, rollup } from "./import.ts";

type Cell = string | number | null;
type Table = { name: string; columns: string[]; select: string[]; orderBy: string };

const PAGE = 1000;

/** Source D1 query via `cf d1 raw`. Refuses anything that is not a single SELECT or PRAGMA. */
function query(db: string, sql: string): { columns: string[]; rows: Cell[][] } {
	if (!/^\s*(select|pragma)\b/i.test(sql) || sql.includes(";")) throw new Error(`refusing non-read-only SQL: ${sql}`);
	const out = execFileSync("npx", ["cf", "d1", "raw", db, "--sql", sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	// Output: [{results: {columns: string[], rows: unknown[][]}, success, meta}], one entry per statement.
	const parsed = JSON.parse(out) as { results: { columns: string[]; rows: Cell[][] }; success: boolean }[];
	const first = parsed[0];
	if (!first?.success) throw new Error(`query failed: ${sql}`);
	return first.results;
}

/** Column names of a table, empty when the table does not exist. */
function columnsOf(db: string, table: string): Set<string> {
	const { columns, rows } = query(db, `PRAGMA table_info(${table})`);
	const name = columns.indexOf("name");
	return new Set(rows.map((r) => String(r[name])));
}

/** Read a whole table in pages. Only columns that exist are selected. */
function* readTable(db: string, table: string, want: string[], orderBy: string): Generator<Record<string, Cell>> {
	const have = columnsOf(db, table);
	if (have.size === 0) {
		console.error(`${table}: table not found, skipped`);
		return;
	}
	const select = want.filter((c) => have.has(c));
	console.error(`${table}: columns ${select.join(", ")}`);
	for (let offset = 0; ; offset += PAGE) {
		const { rows } = query(db, `SELECT ${select.join(", ")} FROM ${table} ORDER BY ${orderBy} LIMIT ${PAGE} OFFSET ${offset}`);
		for (const r of rows) yield Object.fromEntries(select.map((c, i) => [c, r[i] ?? null]));
		if (rows.length < PAGE) return;
	}
}

const text = (v: Cell | undefined): string | undefined => (v === null || v === undefined || v === "" ? undefined : String(v));
const lower = (v: Cell | undefined): string | undefined => text(v)?.toLowerCase();

function props(entries: Record<string, Cell | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(entries)) {
		const t = text(v);
		if (t) out[k] = t;
	}
	return out;
}

function* chmonitorRows(db: string): Generator<RawRow> {
	// install_place is left out on purpose: it is a hash, so it would only add noise to the dims.
	for (const r of readTable(db, "ping_daily", ["day", "instance_hash", "deploy_target", "ch_version", "ch_flavor", "country", "platform", "chm_version"], "day, instance_hash")) {
		yield {
			day: String(r.day),
			id: text(r.instance_hash),
			event: "ping",
			version: text(r.chm_version),
			os: lower(r.platform),
			country: text(r.country),
			props: props({ deploy_target: r.deploy_target, ch_version: r.ch_version, ch_flavor: r.ch_flavor }),
		};
	}
	for (const r of readTable(db, "cli_daily", ["day", "install_id", "event", "command", "cli_version", "os", "arch"], "day, install_id, event, command")) {
		yield {
			day: String(r.day),
			id: text(r.install_id),
			event: String(r.event),
			version: text(r.cli_version),
			os: lower(r.os),
			arch: lower(r.arch),
			props: props({ command: r.command }),
		};
	}
	// `events` has no install id, so it adds events and never users. The source table was written
	// one row per distinct (day, event, deploy_target, ch_version, ch_flavor), so each row is n = 1
	// and the imported event counts are a lower bound of what chmonitor really saw.
	for (const r of readTable(db, "events", ["day", "event", "deploy_target", "ch_version", "ch_flavor"], "id")) {
		yield {
			day: String(r.day),
			event: String(r.event),
			props: props({ deploy_target: r.deploy_target, ch_version: r.ch_version, ch_flavor: r.ch_flavor }),
		};
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			db: { type: "string", default: process.env.CHM_TELEMETRY_D1_ID },
			base: { type: "string" },
			project: { type: "string", default: "chmonitor" },
			apply: { type: "boolean", default: false },
		},
	});
	if (!values.db) throw new Error("need --db <d1-uuid> (or env CHM_TELEMETRY_D1_ID)");
	if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("need env CLOUDFLARE_ACCOUNT_ID for the source database");

	const rollups = rollup([...chmonitorRows(values.db)]);
	if (!values.apply) {
		printRollups(rollups);
		console.error("dry run: nothing posted. Pass --apply with --base and TELEMETRY_ADMIN_TOKEN to import.");
	} else {
		const token = process.env.TELEMETRY_ADMIN_TOKEN;
		if (!values.base || !token) throw new Error("--apply needs --base and env TELEMETRY_ADMIN_TOKEN");
		const res = await postRollups(rollups, { base: values.base, project: values.project, token });
		console.error(`imported ${res.imported}, skipped ${res.skipped} (days already rolled up from live data)`);
	}
}
