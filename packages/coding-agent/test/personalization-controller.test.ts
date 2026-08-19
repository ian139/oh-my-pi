import { describe, expect, it, setSystemTime } from "bun:test";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	assignPersonalizationArm,
	PersonalizationController,
} from "@oh-my-pi/pi-coding-agent/personalization/controller";
import { PersonalizationStore } from "@oh-my-pi/pi-coding-agent/personalization/store";
import type { PersonalizationProposal, TrajectoryInput } from "@oh-my-pi/pi-coding-agent/personalization/types";
import { scorePersonalizationTrajectory } from "@oh-my-pi/pi-coding-agent/personalization/validation";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("personalization controller policy", () => {
	it("assigns a replay to the same deterministic canary arm", () => {
		const first = assignPersonalizationArm(42, "session-a:prompt-hash");
		expect(assignPersonalizationArm(42, "session-a:prompt-hash")).toBe(first);
		expect(["control", "treatment"]).toContain(first);
	});

	it("uses the policy utility scorer", () => {
		expect(
			scorePersonalizationTrajectory({
				completed: true,
				toolErrorCount: 0,
				automaticRetryCount: 0,
				deniedApprovalCount: 0,
				explicitFeedback: null,
			}),
		).toBe(0.75);
	});
});

	it("preserves one turn across continuations and isolates assignment outcome failures", async () => {
		const tempDir = TempDir.createSync("@test-personalization-controller-");
		const store = PersonalizationStore.open(tempDir.join("agent.db"));
		const project = store.ensureProject("project", "/project");
		const evidenceInput: TrajectoryInput = {
			projectId: project.id,
			promptPreview: "focused-test evidence",
			promptHash: "evidence",
			model: null,
			durationMs: 1,
			sessionId: "evidence",
			sessionRef: null,
			toolCount: 0,
			errorCount: 0,
			retryCount: 0,
			deniedCount: 0,
			utility: 0.75,
		};
		const evidence = store.recordTrajectory(evidenceInput);
		const proposal: PersonalizationProposal = {
			kind: "instruction",
			scope: "project",
			title: "Focused",
			trigger: { terms: ["focused-test"], match: "any" },
			content: "Stay focused.",
			evidenceTrajectoryIds: [evidence.id],
		};
		const first = store.createCandidate(project.id, proposal, { type: "user", ref: "first" });
		const second = store.createCandidate(project.id, proposal, { type: "user", ref: "second" });
		store.transition(first.id, "active", { actor: "user", reason: "test" });
		store.transition(second.id, "active", { actor: "user", reason: "test" });
		const originalRecordOutcome = store.recordOutcome.bind(store);
		let outcomeAttempts = 0;
		store.recordOutcome = input => {
			outcomeAttempts++;
			if (outcomeAttempts === 1) throw new Error("first assignment failed");
			originalRecordOutcome(input);
		};
		const values = new Map<string, unknown>([
			["personalization.enabled", true],
			["personalization.retentionDays", 30],
			["personalization.minEvidence", 2],
			["personalization.minEvaluationSamples", 3],
			["personalization.promotionMargin", 0.1],
			["personalization.regressionThreshold", 0.15],
			["personalization.autoPromoteLowRisk", false],
			["autolearn.minToolCalls", 5],
		]);
		const settings = { get: (key: string) => values.get(key) } as unknown as Settings;
		const controller = new PersonalizationController({
			settings,
			cwd: "/project",
			agentDir: tempDir.join("agent"),
			getSessionId: () => "session",
			storeFactory: () => store,
			projectResolver: async () => ({ identity: "project", root: "/project" }),
		});
		try {
			setSystemTime(1_000);
			expect(await controller.beginTurn("focused-test now")).toHaveLength(2);
			controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "one",
				toolName: "read",
				isError: false,
			} as AgentSessionEvent);
			controller.handleEvent({ type: "agent_end", messages: [], isTerminal: false } as AgentSessionEvent);
			controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: "two",
				toolName: "read",
				isError: true,
			} as AgentSessionEvent);
			controller.handleEvent({ type: "auto_retry_start" } as AgentSessionEvent);
			controller.recordDeniedApproval();
			setSystemTime(5_000);
			controller.handleEvent({
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop" }],
				isTerminal: true,
			} as AgentSessionEvent);
			expect(store.getLatestTrajectory(project.id)).toMatchObject({
				durationMs: 4_000,
				toolCount: 2,
				errorCount: 1,
				retryCount: 1,
				deniedCount: 1,
				utility: 0.4,
			});
			expect(outcomeAttempts).toBe(2);
			expect(store.getOutcomeStats(second.id).get("active")?.utility).toBe(0.4);
		} finally {
			setSystemTime();
			controller.close();
			await tempDir.remove();
		}
	});
