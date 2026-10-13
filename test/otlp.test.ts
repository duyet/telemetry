import { beforeEach, expect, test } from "bun:test";
import { ensureReady } from "../src/db.ts";
import { DAILY_CAP, reserve, resetGuard } from "../src/guard.ts";
import { app } from "../src/index.ts";
import { parseOtlp } from "../src/otlp.ts";
import { call, makeEnv, type TestEnv } from "./fakes.ts";

beforeEach(resetGuard);

const s = (key: string, v: string) => ({ key, value: { stringValue: v } });
const resource = {
	attributes: [
		s("service.name", "my-cli"),
		s("service.instance.id", "inst-1"),
		s("service.version", "1.2.3"),
		s("os.type", "Linux"),
		s("host.arch", "amd64"),
		{ key: "ci", value: { boolValue: true } },
		s("deployment.environment", "docker"),
	],
};

// Shaped like the opentelemetry-proto JSON examples.
const logs = {
	resourceLogs: [
		{
			resource,
			scopeLogs: [
				{
					scope: { name: "my.library", version: "1.0.0" },
					logRecords: [
						{
							timeUnixNano: "1544712660300000000",
							severityNumber: 10,
							severityText: "Information",
							body: { stringValue: "Example log record" },
							attributes: [
								s("event.name", "app.start"),
								{ key: "boolean.attribute", value: { boolValue: true } },
								{ key: "int.attribute", value: { intValue: "10" } },
								{ key: "double.attribute", value: { doubleValue: 637.704 } },
								{
									key: "array.attribute",
									value: { arrayValue: { values: [{ stringValue: "many" }, { stringValue: "values" }] } },
								},
								{
									key: "map.attribute",
									value: { kvlistValue: { values: [{ key: "some.map.key", value: { stringValue: "v" } }] } },
								},
							],
						},
						{ body: { stringValue: "app.stop" } },
						{ body: { stringValue: "Example log record with spaces" } },
					],
				},
			],
		},
	],
};

const traces = {
	resourceSpans: [
		{
			resource,
			scopeSpans: [
				{
					spans: [
						{
							traceId: "5B8EFFF798038103D269B633813FC60C",
							spanId: "EEE19B7EC3C1B174",
							name: "cli.run",
							kind: 1,
							attributes: [s("command", "hosts")],
						},
						{ name: "cli.run", attributes: [s("command", "hosts")] },
						{ name: "" },
					],
				},
			],
		},
	],
};

const metrics = {
	resourceMetrics: [
		{
			resource,
			scopeMetrics: [
				{
					metrics: [
						{
							name: "runs",
							unit: "1",
							sum: { dataPoints: [{ asInt: "3" }, { asDouble: 1.6 }], aggregationTemporality: 1, isMonotonic: true },
						},
						{ name: "queue.depth", gauge: { dataPoints: [{ asDouble: 2 }, { asDouble: 5 }, { asInt: "9" }] } },
						{ name: "latency", histogram: { dataPoints: [{ count: "10", sum: 5 }, { count: "5", sum: 1 }] } },
						{ name: "size", exponentialHistogram: { dataPoints: [{ count: "7" }] } },
						{ name: "empty.gauge", gauge: { dataPoints: [] } },
						{ name: "legacy", summary: { dataPoints: [{ count: "1" }] } },
					],
				},
			],
		},
	],
};

async function setup(): Promise<TestEnv> {
	const t = makeEnv();
	await ensureReady(t.env.DB);
	t.db.sqlite.run("INSERT INTO projects (slug, admin_hash, created_at) VALUES ('demo', 'x', '2026-01-01')");
	return t;
}

const JSON_HEADERS = { "content-type": "application/json" };

function otlp(t: TestEnv, signal: string, body: BodyInit, headers: Record<string, string> = JSON_HEADERS) {
	return call(app, t.env, `/demo/v1/${signal}`, { method: "POST", body, headers });
}

const gz = (v: unknown) => Bun.gzipSync(typeof v === "string" ? v : JSON.stringify(v));
const blobs = (t: TestEnv) => t.events.points.map((p) => p.blobs as string[]);

test("OTLP resource attributes map onto the native fields so one SDK setup fills every dimension", () => {
	const { inputs, total } = parseOtlp("logs", logs);
	expect(total).toBe(3);
	expect(inputs[0]).toMatchObject({
		event: "app.start",
		id: "inst-1",
		version: "1.2.3",
		os: "Linux",
		arch: "amd64",
		ci: true,
	});
});

test("the event name falls back from event.name to a body that is a valid name to the literal 'log'", () => {
	const { inputs } = parseOtlp("logs", logs);
	expect(inputs.map((i) => i.event)).toEqual(["app.start", "app.stop", "log"]);
});

test("all AnyValue kinds decode, and record attributes come before resource attributes in props", () => {
	const props = parseOtlp("logs", logs).inputs[0].props;
	expect(Object.keys(props ?? {})).toEqual([
		"boolean.attribute",
		"int.attribute",
		"double.attribute",
		"array.attribute",
		"map.attribute",
		"deployment.environment",
	]);
	expect(props).toMatchObject({
		"boolean.attribute": true,
		"int.attribute": 10,
		"double.attribute": 637.704,
		"array.attribute": '["many","values"]',
		"map.attribute": '{"some.map.key":"v"}',
	});
});

test("identity keys and service.name are not copied into props where they would leak an id", () => {
	const props = parseOtlp("traces", traces).inputs[0].props ?? {};
	for (const k of ["service.name", "service.instance.id", "service.version", "os.type", "host.arch", "ci"]) {
		expect(props).not.toHaveProperty(k);
	}
});

test("the client id falls back through service.instance.id, host.id, user.id and anonymous.id", () => {
	const pick = (...keys: string[]) =>
		parseOtlp("traces", {
			resourceSpans: [
				{
					resource: { attributes: keys.map((k) => s(k, k)) },
					scopeSpans: [{ spans: [{ name: "x" }] }],
				},
			],
		}).inputs[0].id;
	expect(pick("anonymous.id", "user.id", "host.id", "service.instance.id")).toBe("service.instance.id");
	expect(pick("anonymous.id", "user.id", "host.id")).toBe("host.id");
	expect(pick("anonymous.id", "user.id")).toBe("user.id");
	expect(pick("anonymous.id")).toBe("anonymous.id");
	expect(pick()).toBeUndefined();
});

const withResource = (keys: [string, string][], attributes: unknown[] = []) =>
	parseOtlp("traces", {
		resourceSpans: [
			{
				resource: { attributes: keys.map(([k, v]) => s(k, v)) },
				scopeSpans: [{ spans: [{ name: "x", attributes }] }],
			},
		],
	}).inputs[0];

test("host.name, process.command_line and user.email on the resource never reach props, since Analytics Engine keeps them 90 days", () => {
	const input = withResource([
		["host.name", "alice-laptop"],
		["process.command_line", "mycli --token abc"],
		["user.email", "alice@example.com"],
		["service.namespace", "tools"],
	]);
	expect(input.props).toEqual({ "service.namespace": "tools" });
	expect(JSON.stringify(input)).not.toMatch(/alice|token/);
});

test("allowlisted resource keys pass so deployment and SDK dimensions stay queryable", () => {
	const allowed = [
		"deployment.environment",
		"deployment.environment.name",
		"service.namespace",
		"telemetry.sdk.language",
		"telemetry.sdk.name",
		"telemetry.sdk.version",
		"process.runtime.name",
		"process.runtime.version",
		"os.version",
	];
	expect(withResource(allowed.map((k) => [k, "v"])).props).toEqual(Object.fromEntries(allowed.map((k) => [k, "v"])));
});

test("identifying record attributes are dropped but custom ones stay, and user.id still feeds the hashed id", () => {
	const input = withResource([], [
		s("client.address", "10.0.0.1"),
		s("user.id", "u-123"),
		s("http.url", "https://x.test/a?b=1"),
		s("exception.stacktrace", "at /home/alice/app.js"),
		s("db.statement", "select * from users"),
		s("contact_email", "a@b.c"),
		s("api.token", "t"),
		s("request.path", "/home/alice"),
		s("Session.Id", "sid"),
		s("peer.ip", "1.2.3.4"),
		s("client_ip", "1.2.3.4"),
		s("command", "hosts"),
	]);
	expect(input.props).toEqual({ command: "hosts" });
	expect(input.id).toBe("u-123");
});

test("the ip rule matches whole segments only, so zip and tip are not mistaken for addresses", () => {
	const input = withResource([], [s("zip", "z"), s("tip", "t"), s("ip", "x"), s("a.ip.b", "y")]);
	expect(input.props).toEqual({ zip: "z", tip: "t" });
});

test("traces use the span name and metrics derive n from the instrument type", () => {
	expect(parseOtlp("traces", traces).inputs.map((i) => i.event)).toEqual(["cli.run", "cli.run", ""]);
	const m = parseOtlp("metrics", metrics);
	expect(m.total).toBe(6);
	expect(m.inputs.map((i) => [i.event, i.n])).toEqual([
		["runs", 5],
		["queue.depth", 3],
		["latency", 15],
		["size", 7],
	]);
});

const sumMetric = (value: number, aggregationTemporality?: number | string) => ({
	resourceMetrics: [
		{
			scopeMetrics: [
				{
					metrics: [{ name: "runs", sum: { dataPoints: [{ asInt: String(value) }], aggregationTemporality } }],
				},
			],
		},
	],
});

test("a delta sum uses its value, because each export carries only the new occurrences", () => {
	for (const t of [1, "AGGREGATION_TEMPORALITY_DELTA"]) {
		expect(parseOtlp("metrics", sumMetric(7, t)).inputs[0].n).toBe(7);
	}
});

test("a cumulative sum exported twice counts once per export, not its running total of 100 then 150", () => {
	for (const t of [2, "AGGREGATION_TEMPORALITY_CUMULATIVE", undefined]) {
		expect(parseOtlp("metrics", sumMetric(100, t)).inputs[0].n).toBe(1);
		expect(parseOtlp("metrics", sumMetric(150, t)).inputs[0].n).toBe(1);
	}
});

test("garbage payloads parse to nothing instead of throwing", () => {
	for (const body of [null, 5, "x", [], {}, { resourceLogs: "no" }, { resourceLogs: [null, 3] }]) {
		expect(parseOtlp("logs", body).inputs).toEqual([]);
	}
});

test("OTLP logs are written as otlp-sourced points with the same uid hashing as native", async () => {
	const t = await setup();
	const res = await otlp(t, "logs", JSON.stringify(logs));
	expect(res.status).toBe(200);
	expect(t.events.points).toHaveLength(3);
	const [start] = blobs(t);
	expect(start.slice(0, 1).concat(start.slice(2, 8))).toEqual(["app.start", "1.2.3", "linux", "amd64", "vn", "1", "otlp"]);
	expect(start[1]).toMatch(/^[0-9a-f]{16}$/);
	expect(JSON.stringify(t.events.points)).not.toContain("inst-1");
});

test("the empty-ok response is a plain {} so exporters do not retry", async () => {
	const t = await setup();
	const res = await otlp(t, "logs", JSON.stringify({ resourceLogs: [] }));
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({});
	expect(t.events.points).toHaveLength(0);
});

test("traces and metrics endpoints write points, with identical spans merged", async () => {
	const t = await setup();
	expect((await otlp(t, "traces", JSON.stringify(traces))).status).toBe(200);
	expect(t.events.points.map((p) => [p.blobs?.[0], p.doubles?.[0]])).toEqual([["cli.run", 2]]);
	t.events.points.length = 0;
	expect((await otlp(t, "metrics", JSON.stringify(metrics))).status).toBe(200);
	expect(t.events.points.map((p) => [p.blobs?.[0], p.doubles?.[0]])).toEqual([
		["runs", 5],
		["queue.depth", 3],
		["latency", 15],
		["size", 7],
	]);
});

test("gzip bodies are inflated, since the OTLP exporters compress by default", async () => {
	const t = await setup();
	const res = await otlp(t, "logs", gz(logs), { ...JSON_HEADERS, "content-encoding": "gzip" });
	expect(res.status).toBe(200);
	expect(t.events.points).toHaveLength(3);
});

test("a gzip bomb is a 413 and corrupt gzip is a 400, so a tiny request cannot burn the CPU budget", async () => {
	const t = await setup();
	const headers = { ...JSON_HEADERS, "content-encoding": "gzip" };
	const bomb = gz(`{"resourceLogs":[],"pad":"${"0".repeat(2 * 1024 * 1024)}"}`);
	expect(bomb.byteLength).toBeLessThan(256 * 1024);
	expect((await otlp(t, "logs", bomb, headers)).status).toBe(413);
	expect((await otlp(t, "logs", new Uint8Array([1, 2, 3, 4, 5]), headers)).status).toBe(400);
	expect(t.events.points).toHaveLength(0);
});

test("a raw body over 256 KB is a 413", async () => {
	const t = await setup();
	const big = `{"resourceLogs":[],"pad":"${"0".repeat(257 * 1024)}"}`;
	expect((await otlp(t, "logs", big)).status).toBe(413);
});

test("protobuf is a 415 that tells the user which env var switches to JSON", async () => {
	const t = await setup();
	const res = await otlp(t, "logs", new Uint8Array([10, 0]), { "content-type": "application/x-protobuf" });
	expect(res.status).toBe(415);
	expect(await res.json()).toMatchObject({ hint: "set OTEL_EXPORTER_OTLP_PROTOCOL=http/json" });
	expect(t.events.points).toHaveLength(0);
});

test("an unsupported content-encoding is a 415 instead of a confusing parse error", async () => {
	const t = await setup();
	const res = await otlp(t, "logs", "{}", { ...JSON_HEADERS, "content-encoding": "br" });
	expect(res.status).toBe(415);
});

test("rejected records are reported as partialSuccess, using the field name for each signal", async () => {
	const t = await setup();
	const l = (await (await otlp(t, "logs", JSON.stringify({
		resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [s("event.name", "bad name!")] }, { body: { stringValue: "ok" } }] }] }],
	}))).json()) as { partialSuccess: Record<string, unknown> };
	expect(l.partialSuccess.rejectedLogRecords).toBe(1);
	expect(l.partialSuccess.errorMessage).toEqual(expect.any(String));

	const tr = (await (await otlp(t, "traces", JSON.stringify(traces))).json()) as { partialSuccess: Record<string, unknown> };
	expect(tr.partialSuccess.rejectedSpans).toBe(1);

	const m = (await (await otlp(t, "metrics", JSON.stringify(metrics))).json()) as { partialSuccess: Record<string, unknown> };
	expect(m.partialSuccess.rejectedDataPoints).toBe(2);
	expect(t.events.points.map((p) => p.blobs?.[0])).toEqual(["ok", "cli.run", "runs", "queue.depth", "latency", "size"]);
});

test("a request is capped at 250 points, the Analytics Engine per-invocation limit, and the rest is rejected", async () => {
	const t = await setup();
	const spans = Array.from({ length: 300 }, (_, i) => ({ name: `span.${i}` }));
	const body = { resourceSpans: [{ scopeSpans: [{ spans }] }] };
	const res = (await (await otlp(t, "traces", JSON.stringify(body))).json()) as { partialSuccess: Record<string, unknown> };
	expect(t.events.points).toHaveLength(250);
	expect(res.partialSuccess.rejectedSpans).toBe(50);
});

test("OTLP respects the per-project daily cap with a 429 and writes nothing", async () => {
	const t = await setup();
	reserve("demo", DAILY_CAP);
	expect((await otlp(t, "logs", JSON.stringify(logs))).status).toBe(429);
	expect(t.events.points).toHaveLength(0);
});

test("OTLP to an unknown project is a 404 and does no D1 read after warm-up", async () => {
	const t = await setup();
	await otlp(t, "logs", JSON.stringify({ resourceLogs: [] }));
	t.db.resetCounters();
	const res = await call(app, t.env, "/nope/v1/logs", { method: "POST", body: "{}", headers: JSON_HEADERS });
	expect(res.status).toBe(404);
	expect(t.db.reads).toBe(0);
	expect(t.events.points).toHaveLength(0);
});

test("OTLP ingest never touches D1 once warm", async () => {
	const t = await setup();
	await otlp(t, "logs", JSON.stringify({ resourceLogs: [] }));
	t.db.resetCounters();
	await otlp(t, "logs", JSON.stringify(logs));
	await otlp(t, "traces", JSON.stringify(traces));
	await otlp(t, "metrics", JSON.stringify(metrics));
	expect(t.db.reads).toBe(0);
	expect(t.db.writes).toBe(0);
});
