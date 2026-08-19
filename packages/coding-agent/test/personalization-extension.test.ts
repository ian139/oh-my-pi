import { describe, expect, it } from "bun:test";
import { createPersonalizationExtension } from "@oh-my-pi/pi-coding-agent/personalization/extension";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
	ToolApprovalResolvedEvent,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { PersonalizationController } from "@oh-my-pi/pi-coding-agent/personalization/controller";
import type { CandidateRecord } from "@oh-my-pi/pi-coding-agent/personalization/types";

interface Handlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	before_agent_start?: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
	tool_approval_resolved?: ExtensionHandler<ToolApprovalResolvedEvent>;
}

function candidate(content: string): CandidateRecord {
	return {
		id: 1,
		projectId: 1,
		kind: "instruction",
		scope: "project",
		title: "Focused tests",
		status: "active",
		risk: "low",
		trigger: { terms: ["focused-test"], match: "any" },
		content,
		managedSkill: null,
		route: null,
		managedSkillArtifact: null,
		autoPromoted: false,
		promotionBaselineUtility: null,
		promotionBaselineErrorRate: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

function harness(assignments: CandidateRecord[]) {
	const handlers: Handlers = {};
	const activeTools: string[] = [];
	let tool: ToolDefinition | undefined;
	const controller = {
		setEnabled: async () => {},
		beginTurn: async () => assignments.map(item => ({ candidate: item, arm: "active", applied: true as const })),
		recordDeniedApproval: () => {},
	} as unknown as PersonalizationController;
	const settings = { get: () => true, set: () => {} };
	const api = {
		on(event: string, handler: ExtensionHandler<unknown, unknown>) {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand() {},
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: async (names: string[]) => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		setModel: async () => true,
		setThinkingLevel() {},
	} as unknown as ExtensionAPI;
	createPersonalizationExtension({ controller, settings: settings as never })(api);
	return { activeTools, controller, handlers, tool: () => tool };
}

function context(): ExtensionContext {
	return {
		cwd: "/tmp/project",
		model: { provider: "test", id: "model" },
		models: { resolve: () => undefined },
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
		ui: { notify() {} },
	} as unknown as ExtensionContext;
}

describe("personalization extension", () => {
	it("keeps its proposal tool inactive until the enabled session starts", async () => {
		const { activeTools, handlers, tool } = harness([]);
		expect(tool()?.defaultInactive).toBe(true);
		expect(activeTools).not.toContain("propose_personalization");
		await handlers.session_start?.({ type: "session_start" } as SessionStartEvent, context());
		expect(activeTools).toContain("propose_personalization");
	});

	it("appends exactly one matching personalization block", async () => {
		const { handlers } = harness([candidate("Run the narrow focused suite first.")]);
		const result = (await handlers.before_agent_start?.(
			{ type: "before_agent_start", prompt: "run focused-test", systemPrompt: ["base"] },
			context(),
		)) as BeforeAgentStartEventResult;
		expect(result.systemPrompt).toHaveLength(2);
		expect(result.systemPrompt?.[1]).toContain("## Personalization");
		expect(result.systemPrompt?.[1]).toContain("Run the narrow focused suite first.");
	});
});
