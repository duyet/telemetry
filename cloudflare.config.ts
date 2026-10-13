import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "telemetry",
		compatibilityDate: "2026-10-06",
		entrypoint,
		assets: { notFoundHandling: "none" },
		env: {
			DB: bindings.d1({ name: "telemetry" }),
			EVENTS: bindings.analyticsEngineDataset({ name: "telemetry_events" }),
			ANALYTICS: bindings.analytics(),
		},
		triggers: [triggers.scheduled({ schedule: "10 0 * * *" })],
	},
});
