import { describe, expect, it } from "bun:test";
import {
	AutoLearnController,
	type PersonalizationTrajectorySignal,
} from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import legacyAutoLearnPrompt from "../src/prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly captures: string[] = [];
	planEnabled = false;
	goalEnabled = false;
	captureGate: Promise<void> | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	getPlanModeState(): { enabled: boolean } | undefined {
		return this.planEnabled ? { enabled: true } : undefined;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return this.goalEnabled ? { enabled: true } : undefined;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	toolCalls(count: number): void {
		for (let i = 0; i < count; i++) {
			this.emit({ type: "tool_execution_end", toolCallId: `tool-${i}`, toolName: "read", result: null });
		}
	}

	agentStart(): void {
		this.emit({ type: "agent_start" });
	}

	agentEnd(isTerminal = true): void {
		this.emit({ type: "agent_end", messages: [], isTerminal });
	}

	async capture(content: string): Promise<void> {
		this.captures.push(content);
		if (this.captureGate) await this.captureGate;
	}
}

interface Harness {
	session: FakeSession;
	settings: Settings;
	setTrajectory(signal: PersonalizationTrajectorySignal | null): void;
	trajectoryReads(): number;
}

function install(overrides: Record<string, unknown> = {}): Harness {
	const session = new FakeSession();
	const settings = Settings.isolated({
		"autolearn.enabled": false,
		"personalization.enabled": false,
		...overrides,
	});
	let trajectory: PersonalizationTrajectorySignal | null = null;
	let reads = 0;
	new AutoLearnController({
		session: session as unknown as AgentSession,
		settings,
		capture: content => session.capture(content),
		getPersonalizationTrajectory: () => {
			reads++;
			return trajectory;
		},
	});
	return {
		session,
		settings,
		setTrajectory(signal) {
			trajectory = signal;
		},
		trajectoryReads: () => reads,
	};
}

async function settleCaptures(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("AutoLearnController personalization reflection", () => {
	it("preserves the Auto-Learn-only capture prompt byte for byte", () => {
		const { session } = install({
			"autolearn.enabled": true,
			"autolearn.autoContinue": true,
		});
		session.toolCalls(5);
		session.agentEnd();

		expect(session.captures).toEqual([legacyAutoLearnPrompt.trim()]);
	});

	it("runs personalization-only reflection for a negative trajectory below the substantive threshold", () => {
		const harness = install({ "personalization.enabled": true, "personalization.autoReflect": true });
		harness.setTrajectory({ substantive: false, negative: true });
		harness.session.agentEnd();

		expect(harness.session.captures).toHaveLength(1);
		expect(harness.session.captures[0]).toContain("just-recorded trajectory");
		expect(harness.session.captures[0]).toContain("Only `propose_personalization` may change personalization profile state");
		expect(harness.session.captures[0]).not.toContain("`manage_skill`");
		expect(harness.session.captures[0]).not.toContain("`learn`");
	});

	it("selects one combined prompt when both capture purposes are eligible", () => {
		const harness = install({
			"autolearn.enabled": true,
			"autolearn.autoContinue": true,
			"personalization.enabled": true,
			"personalization.autoReflect": true,
		});
		harness.setTrajectory({ substantive: true, negative: false });
		harness.session.toolCalls(5);
		harness.session.agentEnd();

		expect(harness.session.captures).toHaveLength(1);
		const prompt = harness.session.captures[0];
		expect(prompt).toContain("`manage_skill`");
		expect(prompt).toContain("`learn`");
		expect(prompt).toContain("`propose_personalization`");
		expect(prompt).toContain("must cite trajectory evidence");
	});

	it("is inert when both purposes are disabled", () => {
		const harness = install();
		harness.setTrajectory({ substantive: true, negative: true });
		harness.session.toolCalls(5);
		harness.session.agentEnd();

		expect(harness.session.captures).toHaveLength(0);
		expect(harness.trajectoryReads()).toBe(0);
	});

	it("requires an eligible just-recorded trajectory and live autoReflect setting", () => {
		const missing = install({ "personalization.enabled": true, "personalization.autoReflect": true });
		missing.setTrajectory({ substantive: false, negative: false });
		missing.session.agentEnd();
		expect(missing.session.captures).toHaveLength(0);

		const disabled = install({ "personalization.enabled": true, "personalization.autoReflect": false });
		disabled.setTrajectory({ substantive: true, negative: true });
		disabled.session.agentEnd();
		expect(disabled.session.captures).toHaveLength(0);
		expect(disabled.trajectoryReads()).toBe(0);
	});

	it("evaluates a continued primary turn only at its terminal settle", () => {
		const harness = install({
			"autolearn.enabled": true,
			"autolearn.autoContinue": true,
			"personalization.enabled": true,
			"personalization.autoReflect": true,
		});
		harness.setTrajectory({ substantive: true, negative: false });
		harness.session.toolCalls(4);

		harness.session.agentEnd(false);
		expect(harness.session.captures).toHaveLength(0);
		expect(harness.trajectoryReads()).toBe(0);

		harness.session.toolCalls(1);
		harness.session.agentEnd(true);
		expect(harness.session.captures).toHaveLength(1);
		expect(harness.trajectoryReads()).toBe(1);
		expect(harness.session.captures[0]).toContain("capture and personalization reflection");
	});

	it("keeps plan-mode suppression across a non-terminal continuation and resets it at the terminal boundary", () => {
		const harness = install({ "personalization.enabled": true, "personalization.autoReflect": true });
		harness.setTrajectory({ substantive: false, negative: true });
		harness.session.planEnabled = true;
		harness.session.agentStart();
		harness.session.agentEnd(false);
		harness.session.planEnabled = false;
		harness.session.agentStart();
		harness.session.agentEnd(true);
		expect(harness.session.captures).toHaveLength(0);

		harness.session.agentStart();
		harness.session.agentEnd(true);
		expect(harness.session.captures).toHaveLength(1);
	});

	it("coalesces all newer eligible purposes into one rerun", async () => {
		const harness = install({
			"autolearn.enabled": true,
			"autolearn.autoContinue": true,
			"personalization.enabled": true,
			"personalization.autoReflect": true,
		});
		const release = Promise.withResolvers<void>();
		harness.session.captureGate = release.promise;

		// Start a personalization-only capture.
		harness.setTrajectory({ substantive: false, negative: true });
		harness.session.agentEnd();
		// Queue Auto-Learn-only work, then union personalization into that one slot.
		harness.setTrajectory(null);
		harness.session.toolCalls(5);
		harness.session.agentEnd();
		harness.setTrajectory({ substantive: false, negative: true });
		harness.session.agentEnd();
		expect(harness.session.captures).toHaveLength(1);

		harness.session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(harness.session.captures).toHaveLength(2);
		expect(harness.session.captures[1]).toContain("capture and personalization reflection");
	});
});
