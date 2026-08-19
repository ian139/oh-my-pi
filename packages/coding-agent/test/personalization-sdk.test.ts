import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("personalization SDK wiring", () => {
	let dir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		dir = TempDir.createSync("@pi-personalization-sdk-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		registry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		await Promise.all(sessions.map(session => session.dispose().catch(() => {})));
		authStorage.close();
		dir.removeSync();
	});

	async function activeTools(enabled: boolean): Promise<string[]> {
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "personalization.enabled": enabled }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	it("registers the proposal tool inactive while personalization is disabled", async () => {
		expect(await activeTools(false)).not.toContain("propose_personalization");
	});

	it("activates the proposal tool for an enabled top-level session", async () => {
		expect(await activeTools(true)).toContain("propose_personalization");
	});
});
