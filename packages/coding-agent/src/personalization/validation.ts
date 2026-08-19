import { createHash } from "node:crypto";
import { isRecord } from "@oh-my-pi/pi-utils";
import { sanitizeSkillName } from "../autolearn/managed-skills";
import type {
	ArmStatistics,
	CandidateRecord,
	EvaluationDecision,
	EvaluationSettings,
	ManagedSkillProposal,
	PersonalizationArm,
	PersonalizationCandidateKind,
	PersonalizationProposal,
	PersonalizationScope,
	PersonalizationThinkingLevel,
	PersonalizationTrigger,
	RouteProposal,
	TrajectoryScoreInput,
} from "./types";

const KINDS: Record<PersonalizationCandidateKind, true> = {
	instruction: true,
	tool_guidance: true,
	managed_skill: true,
	route: true,
};
const SCOPES: Record<PersonalizationScope, true> = { project: true, global: true };
const THINKING_LEVELS: Record<PersonalizationThinkingLevel, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};
const TOP_LEVEL_KEYS: Record<string, true> = {
	kind: true,
	scope: true,
	title: true,
	trigger: true,
	content: true,
	managedSkill: true,
	route: true,
	evidenceTrajectoryIds: true,
};
const TRIGGER_KEYS: Record<string, true> = { terms: true, match: true };
const SKILL_KEYS: Record<string, true> = { name: true, description: true, body: true };
const ROUTE_KEYS: Record<string, true> = { model: true, thinkingLevel: true };
const MODEL_SELECTOR_PATTERN = /^[a-z0-9][a-z0-9._:@/*+~-]*$/i;
const RESERVED_CONTROL_TOKEN_PATTERNS = [
	/<\/?system(?:[-_:][a-z0-9_-]+)?(?:\s[^<>]*)?>/iu,
	/<\/?(?:developer|assistant|user|tool|function)(?:\s[^<>]*)?>/iu,
	/<\|(?:system|developer|assistant|user|tool)(?:_[a-z0-9_-]+)?\|>/iu,
	/\[\/?(?:system|inst)\]/iu,
	/<<\/?sys>>/iu,
] as const;

export const PERSONALIZATION_LIMITS = Object.freeze({
	title: 120,
	content: 4_000,
	managedSkillName: 48,
	managedSkillBody: 48_000,
	description: 500,
	triggerTerm: 80,
	triggerTerms: 12,
	evidenceTrajectoryIds: 32,
	model: 200,
});

export const PERSONALIZATION_UTILITY_WEIGHTS = Object.freeze({
	base: 0.5,
	completion: 0.25,
	toolError: -0.15,
	automaticRetry: -0.1,
	deniedApproval: -0.1,
	goodFeedback: 0.25,
	badFeedback: -0.5,
});

function assertExactKeys(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>, label: string): void {
	for (const key of Object.keys(value)) {
		if (allowed[key] !== true) throw new Error(`${label} contains unsupported field "${key}".`);
	}
}

function assertNoControlTokens(value: string, label: string): void {
	const withoutAllowedWhitespace = value.replace(/[\t\n\r]/g, "");
	if (/[\p{Cc}\p{Cf}]/u.test(withoutAllowedWhitespace)) {
		throw new Error(`${label} contains a control character.`);
	}
	if (RESERVED_CONTROL_TOKEN_PATTERNS.some(pattern => pattern.test(value))) {
		throw new Error(`${label} contains a reserved control token.`);
	}
}

function requiredString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	assertNoControlTokens(value, label);
	const normalized = value.normalize("NFKC").trim();
	if (!normalized) throw new Error(`${label} must not be empty.`);
	if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
	return normalized;
}

export function normalizePersonalizationTriggerText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function parseTrigger(value: unknown): PersonalizationTrigger {
	if (!isRecord(value)) throw new Error("trigger must be an object.");
	assertExactKeys(value, TRIGGER_KEYS, "trigger");
	if (!Array.isArray(value.terms) || value.terms.length === 0 || value.terms.length > PERSONALIZATION_LIMITS.triggerTerms) {
		throw new Error(`trigger.terms must contain 1-${PERSONALIZATION_LIMITS.triggerTerms} strings.`);
	}
	const terms = value.terms.map((term, index) =>
		normalizePersonalizationTriggerText(requiredString(term, `trigger.terms[${index}]`, PERSONALIZATION_LIMITS.triggerTerm)),
	);
	const uniqueTerms = new Set(terms);
	if (uniqueTerms.size !== terms.length) throw new Error("trigger.terms contains duplicate normalized terms.");
	if (value.match !== "any" && value.match !== "all") throw new Error('trigger.match must be "any" or "all".');
	return { terms, match: value.match };
}

function parseManagedSkill(value: unknown): ManagedSkillProposal {
	if (!isRecord(value)) throw new Error("managedSkill must be an object.");
	assertExactKeys(value, SKILL_KEYS, "managedSkill");
	const rawName = requiredString(value.name, "managedSkill.name", PERSONALIZATION_LIMITS.managedSkillName);
	const name = sanitizeSkillName(rawName);
	if (name !== rawName) throw new Error("managedSkill.name must already be lowercase and normalized.");
	return {
		name,
		description: requiredString(value.description, "managedSkill.description", PERSONALIZATION_LIMITS.description),
		body: requiredString(value.body, "managedSkill.body", PERSONALIZATION_LIMITS.managedSkillBody),
	};
}

function parseRoute(value: unknown): RouteProposal {
	if (!isRecord(value)) throw new Error("route must be an object.");
	assertExactKeys(value, ROUTE_KEYS, "route");
	const model = requiredString(value.model, "route.model", PERSONALIZATION_LIMITS.model);
	if (!MODEL_SELECTOR_PATTERN.test(model)) throw new Error("route.model is not a valid model selector.");
	if (value.thinkingLevel !== undefined && THINKING_LEVELS[value.thinkingLevel as PersonalizationThinkingLevel] !== true) {
		throw new Error("route.thinkingLevel is invalid.");
	}
	return {
		model,
		...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel as PersonalizationThinkingLevel }),
	};
}

function parseEvidenceIds(value: unknown): number[] {
	if (!Array.isArray(value) || value.length > PERSONALIZATION_LIMITS.evidenceTrajectoryIds) {
		throw new Error(`evidenceTrajectoryIds must be an array of at most ${PERSONALIZATION_LIMITS.evidenceTrajectoryIds} ids.`);
	}
	const ids = value.map((id, index) => {
		if (!Number.isSafeInteger(id) || (id as number) <= 0) {
			throw new Error(`evidenceTrajectoryIds[${index}] must be a positive integer.`);
		}
		return id as number;
	});
	if (new Set(ids).size !== ids.length) throw new Error("evidenceTrajectoryIds contains duplicate ids.");
	return ids;
}

export function validatePersonalizationProposal(value: unknown): PersonalizationProposal {
	if (!isRecord(value)) throw new Error("proposal must be a JSON object.");
	assertExactKeys(value, TOP_LEVEL_KEYS, "proposal");
	if (KINDS[value.kind as PersonalizationCandidateKind] !== true) throw new Error("proposal.kind is invalid.");
	if (SCOPES[value.scope as PersonalizationScope] !== true) throw new Error("proposal.scope is invalid.");
	const kind = value.kind as PersonalizationCandidateKind;
	const scope = value.scope as PersonalizationScope;
	const title = requiredString(value.title, "proposal.title", PERSONALIZATION_LIMITS.title);
	const trigger = parseTrigger(value.trigger);
	const evidenceTrajectoryIds = parseEvidenceIds(value.evidenceTrajectoryIds);

	if (kind === "instruction" || kind === "tool_guidance") {
		if (value.managedSkill !== undefined || value.route !== undefined) {
			throw new Error(`${kind} proposals only accept content.`);
		}
		return {
			kind,
			scope,
			title,
			trigger,
			content: requiredString(value.content, "proposal.content", PERSONALIZATION_LIMITS.content),
			evidenceTrajectoryIds,
		};
	}
	if (kind === "managed_skill") {
		if (scope !== "project") throw new Error("managed_skill proposals must use project scope.");
		if (value.content !== undefined || value.route !== undefined) {
			throw new Error("managed_skill proposals only accept managedSkill.");
		}
		return { kind, scope, title, trigger, managedSkill: parseManagedSkill(value.managedSkill), evidenceTrajectoryIds };
	}
	if (value.content !== undefined || value.managedSkill !== undefined) {
		throw new Error("route proposals only accept route.");
	}
	return { kind, scope, title, trigger, route: parseRoute(value.route), evidenceTrajectoryIds };
}

export function parsePersonalizationProposalJson(json: string): PersonalizationProposal {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new Error(`Invalid proposal JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validatePersonalizationProposal(value);
}

export function isLowRiskProposal(proposal: PersonalizationProposal): boolean {
	return proposal.scope === "project" && (proposal.kind === "instruction" || proposal.kind === "tool_guidance");
}

export function matchesPersonalizationTrigger(trigger: PersonalizationTrigger, prompt: string): boolean {
	const normalizedPrompt = normalizePersonalizationTriggerText(prompt);
	return trigger.match === "all"
		? trigger.terms.every(term => normalizedPrompt.includes(normalizePersonalizationTriggerText(term)))
		: trigger.terms.some(term => normalizedPrompt.includes(normalizePersonalizationTriggerText(term)));
}

export function assignPersonalizationArm(candidateId: number, stableTurnIdentity: string): Exclude<PersonalizationArm, "active"> {
	if (!Number.isSafeInteger(candidateId) || candidateId <= 0) throw new Error("candidateId must be a positive integer.");
	if (!stableTurnIdentity) throw new Error("stableTurnIdentity must not be empty.");
	const digest = createHash("sha256").update(`${candidateId}\0${stableTurnIdentity}`).digest();
	return (digest[0] & 1) === 0 ? "control" : "treatment";
}

export function scorePersonalizationTrajectory(input: TrajectoryScoreInput): number {
	const errors = Math.max(0, Math.floor(input.toolErrorCount));
	const retries = Math.max(0, Math.floor(input.automaticRetryCount));
	const denied = Math.max(0, Math.floor(input.deniedApprovalCount));
	let utility = PERSONALIZATION_UTILITY_WEIGHTS.base;
	if (input.completed) utility += PERSONALIZATION_UTILITY_WEIGHTS.completion;
	utility += errors * PERSONALIZATION_UTILITY_WEIGHTS.toolError;
	utility += retries * PERSONALIZATION_UTILITY_WEIGHTS.automaticRetry;
	utility += denied * PERSONALIZATION_UTILITY_WEIGHTS.deniedApproval;
	if (input.explicitFeedback === "good") utility += PERSONALIZATION_UTILITY_WEIGHTS.goodFeedback;
	if (input.explicitFeedback === "bad") utility += PERSONALIZATION_UTILITY_WEIGHTS.badFeedback;
	return Math.min(1, Math.max(0, utility));
}

export function decidePersonalizationEvaluation(
	candidate: CandidateRecord,
	evidenceCount: number,
	stats: ReadonlyMap<PersonalizationArm, ArmStatistics>,
	settings: EvaluationSettings,
): EvaluationDecision | null {
	if (candidate.status === "pending") {
		if (candidate.risk !== "low" || !settings.autoPromoteLowRisk || evidenceCount < settings.minEvidence) return null;
		return { candidateId: candidate.id, from: "pending", to: "canary", reason: "minimum evidence reached" };
	}
	if (candidate.status === "canary") {
		if (candidate.risk !== "low") return null;
		const control = stats.get("control");
		const treatment = stats.get("treatment");
		if (!control || !treatment) return null;
		if (control.samples < settings.minEvaluationSamples || treatment.samples < settings.minEvaluationSamples) return null;
		if (treatment.utility - control.utility < settings.promotionMargin) return null;
		if (treatment.errorRate > control.errorRate) return null;
		return {
			candidateId: candidate.id,
			from: "canary",
			to: "active",
			reason: "canary utility margin met without error regression",
		};
	}
	if (candidate.status !== "active" || !candidate.autoPromoted) return null;
	const active = stats.get("active");
	if (!active || active.samples < settings.minEvaluationSamples) return null;
	if (candidate.promotionBaselineUtility === null || candidate.promotionBaselineErrorRate === null) return null;
	const utilityRegressed = candidate.promotionBaselineUtility - active.utility >= settings.regressionThreshold;
	const errorRateRegressed = active.errorRate > candidate.promotionBaselineErrorRate;
	if (!utilityRegressed && !errorRateRegressed) return null;
	return {
		candidateId: candidate.id,
		from: "active",
		to: "rolled_back",
		reason: utilityRegressed
			? "active utility regressed below the promotion baseline"
			: "active error rate regressed above the promotion baseline",
	};
}
