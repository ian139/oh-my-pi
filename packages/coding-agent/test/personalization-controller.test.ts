import { describe, expect, it } from "bun:test";
import {
	assignPersonalizationArm,
	clampUtility,
	scorePersonalizationTrajectory,
} from "@oh-my-pi/pi-coding-agent/personalization/controller";

describe("personalization controller policy", () => {
	it("assigns a replay to the same deterministic canary arm", () => {
		const first = assignPersonalizationArm(42, "session-a:prompt-hash");
		expect(assignPersonalizationArm(42, "session-a:prompt-hash")).toBe(first);
		expect(["control", "treatment"]).toContain(first);
	});

	it("scores bounded utility from named negative signals", () => {
		expect(scorePersonalizationTrajectory({ completed: true, errorCount: 0, retryCount: 0, deniedCount: 0 })).toBe(1);
		expect(
			scorePersonalizationTrajectory({ completed: false, errorCount: 100, retryCount: 100, deniedCount: 100 }),
		).toBe(0);
		expect(clampUtility(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampUtility(Number.NaN)).toBe(0);
	});
});
