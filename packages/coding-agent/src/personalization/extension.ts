import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import type { Settings } from "../config/settings";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../extensibility/extensions";
import type { PersonalizationController, PersonalizationStatusSnapshot } from "./controller";
import {
	PERSONALIZATION_TOOL_NAME,
	type CandidateRecord,
	type PersonalizationProposal,
	type TurnCandidateAssignment,
} from "./types";
import { parsePersonalizationProposalJson } from "./validation";

const LOW_RISK_EXAMPLE =
	'{"kind":"instruction","scope":"project","title":"Focused tests","trigger":{"terms":["focused-test"],"match":"any"},"content":"Run the focused test before broad validation.","evidenceTrajectoryIds":[1,2]}';
const HIGH_RISK_EXAMPLE =
	'{"kind":"route","scope":"project","title":"Deep review route","trigger":{"terms":["deep-review"],"match":"any"},"route":{"model":"@slow","thinkingLevel":"high"},"evidenceTrajectoryIds":[1,2]}';
const USAGE = [
	"Usage: /personalize on|off|status|feedback good [note]|feedback bad [note]|propose <JSON>|review [id]|approve <id>|reject <id> [reason]|rollback <id>",
	`Low-risk example: /personalize propose ${LOW_RISK_EXAMPLE}`,
	`High-risk example: /personalize propose ${HIGH_RISK_EXAMPLE}`,
].join("\n");

const triggerSchema = type({
	terms: type("string[]").describe("one to twelve normalized literal trigger terms"),
	match: type("'any' | 'all'").describe("whether any or all terms must occur"),
});
const managedSkillSchema = type({
	name: type("string").describe("normalized managed skill suffix"),
	description: type("string").describe("managed skill description"),
	body: type("string").describe("managed skill body"),
});
const routeSchema = type({
	model: type("string").describe("model selector or configured role"),
	"thinkingLevel?": type("'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'"),
});
const proposalSchema = type({
	kind: type("'instruction' | 'tool_guidance' | 'managed_skill' | 'route'"),
	scope: type("'project' | 'global'"),
	title: type("string"),
	trigger: triggerSchema,
	"content?": type("string"),
	"managedSkill?": managedSkillSchema,
	"route?": routeSchema,
	evidenceTrajectoryIds: type("number[]"),
});

export interface PersonalizationExtensionOptions {
	controller: PersonalizationController;
	settings: Settings;
}

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function candidateSummary(candidate: CandidateRecord, evidenceCount?: number): string {
	const parts = [
		`Candidate ${candidate.id}: ${candidate.title}`,
		`kind=${candidate.kind} scope=${candidate.scope} risk=${candidate.risk} status=${candidate.status}`,
		`trigger=${candidate.trigger.match}(${candidate.trigger.terms.join(", ")})`,
	];
	if (evidenceCount !== undefined) parts.push(`evidence=${evidenceCount}`);
	if (candidate.content) parts.push(`content=${candidate.content}`);
	if (candidate.managedSkill) parts.push(`managedSkill=${candidate.managedSkill.name}`);
	if (candidate.route) {
		parts.push(`route=${candidate.route.model}${candidate.route.thinkingLevel ? ` thinking=${candidate.route.thinkingLevel}` : ""}`);
	}
	return parts.join("\n");
}

function statusSummary(status: PersonalizationStatusSnapshot): string {
	const counts = Object.entries(status.candidates)
		.map(([name, count]) => `${name}=${count}`)
		.join(" ");
	return [
		`Personalization: ${status.enabled ? "on" : "off"}`,
		`Storage: ${status.storage}`,
		`Project: ${status.project?.root ?? "unopened"}`,
		`Candidates: ${counts}`,
		`Latest trajectory: ${status.latestTrajectoryId ?? "none"}`,
	].join("\n");
}

function formatOverlay(assignments: TurnCandidateAssignment[]): string | null {
	const instructions = assignments.filter(
		assignment => assignment.applied && assignment.candidate.kind === "instruction" && assignment.candidate.content,
	);
	const toolGuidance = assignments.filter(
		assignment => assignment.applied && assignment.candidate.kind === "tool_guidance" && assignment.candidate.content,
	);
	if (instructions.length === 0 && toolGuidance.length === 0) return null;
	const lines = ["## Personalization"];
	if (instructions.length > 0) {
		lines.push("Instructions:", ...instructions.map(assignment => `- ${assignment.candidate.content}`));
	}
	if (toolGuidance.length > 0) {
		lines.push("Tool guidance:", ...toolGuidance.map(assignment => `- ${assignment.candidate.content}`));
	}
	return lines.join("\n");
}

function positiveId(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function applyRoute(
	api: ExtensionAPI,
	ctx: ExtensionContext,
	controller: PersonalizationController,
	assignments: TurnCandidateAssignment[],
): Promise<void> {
	const routes = assignments
		.filter(assignment => assignment.applied && assignment.candidate.kind === "route" && assignment.candidate.route)
		.sort((left, right) => right.candidate.id - left.candidate.id);
	const winner = routes[0];
	if (!winner) return;
	const shadowed = routes.slice(1).map(assignment => assignment.candidate);
	for (const assignment of routes.slice(1)) controller.markAssignmentNotApplied(assignment.candidate.id);
	controller.recordRouteShadow(winner.candidate, shadowed);
	const route = winner.candidate.route;
	if (!route) return;
	const model = ctx.models.resolve(route.model);
	if (!model) {
		controller.markAssignmentNotApplied(winner.candidate.id);
		ctx.ui.notify(`Personalization route ${winner.candidate.id} could not resolve model "${route.model}"; route not applied.`, "error");
		return;
	}
	if (!(await api.setModel(model))) {
		controller.markAssignmentNotApplied(winner.candidate.id);
		ctx.ui.notify(`Personalization route ${winner.candidate.id} has no authenticated credential for "${route.model}"; route not applied.`, "error");
		return;
	}
	controller.updateTurnModel(`${model.provider}/${model.id}`);
	if (route.thinkingLevel) api.setThinkingLevel(route.thinkingLevel as ThinkingLevel);
}

export function createPersonalizationExtension(options: PersonalizationExtensionOptions): ExtensionFactory {
	return api => {
		const syncToolState = async (enabled: boolean): Promise<void> => {
			await options.controller.setEnabled(enabled);
			const active = api.getActiveTools();
			const next = enabled
				? active.includes(PERSONALIZATION_TOOL_NAME)
					? active
					: [...active, PERSONALIZATION_TOOL_NAME]
				: active.filter(name => name !== PERSONALIZATION_TOOL_NAME);
			if (next.length !== active.length || next.some((name, index) => name !== active[index])) {
				await api.setActiveTools(next);
			}
		};

		api.registerTool({
			name: PERSONALIZATION_TOOL_NAME,
			label: "Propose Personalization",
			description:
				"Propose one validated, auditable personalization candidate backed by trajectory IDs. This never approves or directly activates high-risk changes.",
			parameters: proposalSchema,
			defaultInactive: true,
			approval: "write",
			strict: true,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					const result = await options.controller.propose(params as PersonalizationProposal, {
						type: "model",
						ref: ctx.sessionManager.getSessionId(),
					});
					return textResult(candidateSummary(result.candidate, result.evidenceCount), result);
				} catch (error) {
					return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
		});

		api.registerCommand("personalize", {
			description: "Control local trajectory-driven personalization.",
			async handler(args, ctx): Promise<void> {
				const input = args.trim();
				try {
					if (input === "on") {
						options.settings.set("personalization.enabled", true);
						await syncToolState(true);
						ctx.ui.notify("Personalization enabled.", "info");
						return;
					}
					if (input === "off") {
						options.settings.set("personalization.enabled", false);
						await syncToolState(false);
						ctx.ui.notify("Personalization disabled; local history and candidates were preserved.", "info");
						return;
					}
					if (input === "status") {
						ctx.ui.notify(statusSummary(await options.controller.status()), "info");
						return;
					}
					const feedbackMatch = /^feedback\s+(good|bad)(?:\s+(.+))?$/.exec(input);
					if (feedbackMatch) {
						const note = feedbackMatch[2]?.trim() || null;
						if (note && note.length > 500) throw new Error("Feedback note exceeds 500 characters.");
						const trajectory = await options.controller.feedback(feedbackMatch[1] as "good" | "bad", note);
						ctx.ui.notify(`Recorded ${feedbackMatch[1]} feedback for trajectory ${trajectory.id}.`, "info");
						return;
					}
					if (input.startsWith("propose ")) {
						const proposal = parsePersonalizationProposalJson(input.slice("propose ".length));
						const result = await options.controller.propose(proposal, {
							type: "user",
							ref: ctx.sessionManager.getSessionId(),
						});
						ctx.ui.notify(candidateSummary(result.candidate, result.evidenceCount), "info");
						return;
					}
					if (input === "review") {
						const candidates = await options.controller.listCandidates();
						ctx.ui.notify(candidates.length > 0 ? candidates.map(candidate => candidateSummary(candidate)).join("\n\n") : "No personalization candidates.", "info");
						return;
					}
					const reviewMatch = /^review\s+(\S+)$/.exec(input);
					if (reviewMatch) {
						const id = positiveId(reviewMatch[1]);
						if (!id) throw new Error("review requires a positive candidate id.");
						ctx.ui.notify(candidateSummary(await options.controller.getCandidate(id)), "info");
						return;
					}
					const approveMatch = /^approve\s+(\S+)$/.exec(input);
					if (approveMatch) {
						const id = positiveId(approveMatch[1]);
						if (!id) throw new Error("approve requires a positive candidate id.");
						ctx.ui.notify(candidateSummary(await options.controller.approve(id)), "info");
						return;
					}
					const rejectMatch = /^reject\s+(\S+)(?:\s+(.+))?$/.exec(input);
					if (rejectMatch) {
						const id = positiveId(rejectMatch[1]);
						if (!id) throw new Error("reject requires a positive candidate id.");
						ctx.ui.notify(candidateSummary(await options.controller.reject(id, rejectMatch[2]?.trim() || null)), "info");
						return;
					}
					const rollbackMatch = /^rollback\s+(\S+)$/.exec(input);
					if (rollbackMatch) {
						const id = positiveId(rollbackMatch[1]);
						if (!id) throw new Error("rollback requires a positive candidate id.");
						ctx.ui.notify(candidateSummary(await options.controller.rollback(id)), "info");
						return;
					}
					throw new Error(USAGE);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		api.on("session_start", async (_event, ctx) => {
			try {
				await syncToolState(options.settings.get("personalization.enabled") === true);
			} catch (error) {
				ctx.ui.notify(`Personalization initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		});
		api.on("tool_approval_resolved", event => {
			if (!event.approved) options.controller.recordDeniedApproval();
		});
		api.on("before_agent_start", async (event, ctx) => {
			const enabled = options.settings.get("personalization.enabled") === true;
			await syncToolState(enabled);
			if (!enabled) return;
			const assignments = await options.controller.beginTurn(event.prompt);
			await applyRoute(api, ctx, options.controller, assignments);
			const overlay = formatOverlay(assignments);
			if (!overlay) return;
			return { systemPrompt: [...(Array.isArray(event.systemPrompt) ? event.systemPrompt : []), overlay] };
		});
		api.on("session_shutdown", () => {
			options.controller.close();
		});
	};
}
