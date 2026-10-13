import { describe, expect, test } from "bun:test";
import { agentPrompt, agentsMd, apiMd, installMd, llmsTxt, snippets } from "../src/docs/content.ts";

const BASE = "https://telemetry.example.dev";
const PROJECT = "herdr-desk";
const ENDPOINT = `${BASE}/${PROJECT}`;

describe("agent-facing docs carry the exact project endpoint", () => {
	// An agent copies these verbatim. A wrong URL means telemetry that silently goes nowhere.
	test("install.md names the endpoint, the stats url and the env vars derived from the slug", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toContain(`POST ${ENDPOINT}`);
		expect(md).toContain(`${BASE}/api/${PROJECT}/stats`);
		expect(md).toContain("HERDR_DESK_TELEMETRY_DISABLED");
		expect(md).toContain("HERDR_DESK_TELEMETRY_DEBUG");
		expect(md).toContain("DO_NOT_TRACK");
		expect(md).not.toContain("${");
	});

	// Field reports: agents shipped daemons that pinged every tick and debug modes that wrote files.
	test("install.md states the server semantics: UTC days, any id event is an active user", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toContain("UTC");
		expect(md).toContain("active user for that UTC day");
		expect(md).toMatch(/`install` and `ping` are not special/);
		expect(md).toContain("at most one `ping` per UTC day");
	});

	test("install.md says debug mode has no side effects", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toMatch(/no side effects: no id file, no stamp, no notice/);
	});

	test("install.md says to fail closed when the id or stamp cannot be persisted", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toContain("Fail closed");
		expect(md).toMatch(/id or the daily stamp cannot be saved, skip sending/);
		expect(md).toMatch(/config file exists but cannot be read, do not send/);
	});

	test("install.md offers a dry-run verify path as the required minimum, and a real ping only when network is allowed", () => {
		const md = installMd(BASE, PROJECT);
		const verify = md.slice(md.indexOf("### 7. Verify"));
		expect(verify).toContain("Required, always possible: a dry run");
		expect(verify).toContain("HERDR_DESK_TELEMETRY_DEBUG=1");
		expect(verify).toContain("only when network use is allowed");
		expect(verify.indexOf("dry run")).toBeLessThan(verify.indexOf("real ping"));
	});

	test("install.md defines env truthiness once and names the CI opt-in", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toContain("any value except empty, `0` or `false`");
		expect(md).toContain("HERDR_DESK_TELEMETRY_CI=1");
		expect(md).toContain("`ci:true`");
	});

	test("install.md lets the tool's own env prefix win and does not assume stderr for the notice", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toContain("ANYR_*");
		expect(md).toContain("Prefer the tool's own env prefix");
		expect(md).toMatch(/log or notify channel for a daemon or plugin/);
	});

	test("install.md does not remap os and arch, and leaves short-circuit commands untracked", () => {
		const md = installMd(BASE, PROJECT);
		expect(md).toContain("`aarch64`");
		expect(md).toContain("Do not remap");
		expect(md).toContain("`--version`");
	});

	test("api reference states the same server semantics", () => {
		const md = apiMd(BASE);
		expect(md).toContain("active user for that UTC day");
		expect(md).toContain("Fail closed");
		expect(md).toContain("no id file, no daily stamp, no notice");
	});

	test("agentPrompt points at the project's install.md", () => {
		const prompt = agentPrompt(BASE, PROJECT);
		expect(prompt).toContain(`${ENDPOINT}/install.md`);
		expect(prompt).toContain("DO_NOT_TRACK");
	});

	test("agents.md creates the project with a first curl event and says to save the token, then follow install.md", () => {
		const md = agentsMd(BASE);
		expect(md).toContain(`-X POST ${BASE}/<slug>`);
		expect(md).toContain("admin_token");
		expect(md).toContain("x-telemetry-admin-token");
		expect(md).toContain("Never commit it");
		expect(md).toContain(`${BASE}/<slug>/install.md`);
	});

	// The create endpoint is gone. An agent that follows stale docs gets a 404 and no project.
	test("no doc tells anyone to call the removed create endpoint", () => {
		for (const doc of [apiMd(BASE), agentsMd(BASE), llmsTxt(BASE), installMd(BASE, PROJECT)]) {
			expect(doc).not.toContain(`POST ${BASE}/api/projects`);
			expect(doc).not.toMatch(/-X POST \S*\/api\/projects/);
		}
	});
});

describe("snippets", () => {
	const all = snippets(BASE, PROJECT);

	test("cover every documented language with unique ids", () => {
		const ids = all.map((s) => s.id);
		expect(ids).toEqual(["curl", "shell", "ts", "rust", "go", "python", "browser", "otlp"]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every snippet targets this project's endpoint", () => {
		for (const s of all) expect(s.code, s.id).toContain(ENDPOINT);
	});

	test("no template placeholder leaked into the output", () => {
		for (const s of all) expect(s.code, s.id).not.toMatch(/\/undefined|_UNDEFINED|\[object/);
	});

	test("every snippet that persists an id honors DO_NOT_TRACK and the app opt-out", () => {
		const persisting = all.filter((s) => /telemetry-id/.test(s.code));
		expect(persisting.map((s) => s.id).sort()).toEqual(["browser", "go", "python", "rust", "ts"]);
		for (const s of persisting) {
			if (s.id === "browser") {
				expect(s.code).toContain("doNotTrack");
				expect(s.code).toContain(`${PROJECT}-telemetry-disabled`);
				continue;
			}
			expect(s.code, s.id).toContain("DO_NOT_TRACK");
			expect(s.code, s.id).toContain("HERDR_DESK_TELEMETRY_DISABLED");
			expect(s.code, s.id).toContain("HERDR_DESK_TELEMETRY_DEBUG");
			expect(s.code, s.id).toContain("CI");
		}
	});

	test("the install-script snippet honors the opt-outs and CI without persisting an id", () => {
		const shell = all.find((s) => s.id === "shell");
		expect(shell?.code).toContain("DO_NOT_TRACK");
		expect(shell?.code).toContain("HERDR_DESK_TELEMETRY_DISABLED");
		expect(shell?.code).toContain("CI");
	});

	test("persisting snippets fail closed and keep debug free of side effects", () => {
		for (const id of ["ts", "rust", "go", "python"]) {
			const code = all.find((s) => s.id === id)?.code ?? "";
			expect(code, id).toContain("fail closed");
			expect(code, id).toContain("new-install-id");
			expect(code, id).not.toContain("send without an id");
			expect(code, id).toContain("HERDR_DESK_TELEMETRY_CI");
		}
	});

	test("clients time out within 1 second", () => {
		const byId = Object.fromEntries(all.map((s) => [s.id, s.code]));
		expect(byId.ts).toContain("AbortSignal.timeout(1000)");
		expect(byId.rust).toContain("Duration::from_secs(1)");
		expect(byId.go).toContain("time.Second");
		expect(byId.python).toContain("timeout=1");
		expect(byId.curl).toContain("-m 1");
		expect(byId.shell).toContain("-m 1");
	});

	test("the browser snippet sends application/json through sendBeacon", () => {
		const browser = all.find((s) => s.id === "browser")?.code ?? "";
		expect(browser).toContain("sendBeacon");
		expect(browser).toContain("application/json");
		expect(browser).toContain("localStorage");
	});

	test("otlp snippet sets the endpoint and the json protocol", () => {
		const otlp = all.find((s) => s.id === "otlp")?.code ?? "";
		expect(otlp).toContain(`OTEL_EXPORTER_OTLP_ENDPOINT=${ENDPOINT}`);
		expect(otlp).toContain("OTEL_EXPORTER_OTLP_PROTOCOL=http/json");
	});
});

describe("llms.txt", () => {
	test("starts with the llms.txt header and includes the full API reference", () => {
		const txt = llmsTxt(BASE);
		expect(txt.startsWith("# Telemetry\n\n> ")).toBe(true);
		expect(txt).toContain(`${BASE}/docs`);
		expect(txt).toContain(apiMd(BASE));
	});

	test("the API reference documents the contract an agent relies on", () => {
		const md = apiMd(BASE);
		for (const needle of [
			"^[A-Za-z0-9_.:/-]{1,64}$",
			"429",
			"Retry-After",
			"OTEL_EXPORTER_OTLP_PROTOCOL=http/json",
			"bunx cf deploy",
			"Analytics Engine",
			"/api/projects",
			"?days=7|30|90|365",
			"/import",
			"x-telemetry-admin-token",
			"new project limit reached for today",
			"3 new projects per IP and 100 in total per UTC day",
			"-X PATCH",
			"/token",
			"The slug cannot change",
			"scripts/reset-token.ts",
			"only projects with daily rollups in the last 30 days",
		]) {
			expect(md, needle).toContain(needle);
		}
		expect(md).not.toContain("~~~");
	});
});
