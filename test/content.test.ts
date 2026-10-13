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

	test("agentPrompt points at the project's install.md", () => {
		const prompt = agentPrompt(BASE, PROJECT);
		expect(prompt).toContain(`${ENDPOINT}/install.md`);
		expect(prompt).toContain("DO_NOT_TRACK");
	});

	test("agents.md tells the agent to create a project, then follow install.md", () => {
		const md = agentsMd(BASE);
		expect(md).toContain(`POST ${BASE}/api/projects`);
		expect(md).toContain(`${BASE}/<slug>/install.md`);
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
		]) {
			expect(md, needle).toContain(needle);
		}
		expect(md).not.toContain("~~~");
	});
});
