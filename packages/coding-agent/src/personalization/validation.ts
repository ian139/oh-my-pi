import { isRecord } from "@oh-my-pi/pi-utils";
import { sanitizeSkillName } from "../autolearn/managed-skills";
import type {
	ManagedSkillProposal,
	PersonalizationCandidateKind,
	PersonalizationProposal,
	PersonalizationScope,
	PersonalizationThinkingLevel,
	PersonalizationTrigger,
	RouteProposal,
} from "./types";

const KINDS = new Set<PersonalizationCandidateKind>(["instruction", "tool_guidance", "managed_skill", "route"]);
const SCOPES = new Set<PersonalizationScope>(["project", "global"]);
const THINKING_LEVELS = new Set<PersonalizationThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const TOP_LEVEL_KEYS = new Set(["kind", "scope", "title", "trigger", "content", "managedSkill", "route", "evidenceTrajectoryIds"]);
const TRIGGER_KEYS = new Set(["terms", "match"]);
const SKILL_KEYS = new Set(["name", "description", "body"]);
const ROUTE_KEYS = new Set(["model", "thinkingLevel"]);
const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 4_000;
const MAX_SKILL_BODY_LENGTH = 48_000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TERM_LENGTH = 80;
const MAX_TERMS = 12;
const MAX_EVIDENCE = 32;

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} contains unsupported field "${key}".`);
	}
}

function requiredString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
	if (!normalized) throw new Error(`${label} must not be empty.`);
	if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
	return normalized;
}

function parseTrigger(value: unknown): PersonalizationTrigger {
	if (!isRecord(value)) throw new Error("trigger must be an object.");
	assertExactKeys(value, TRIGGER_KEYS, "trigger");
	if (!Array.isArray(value.terms) || value.terms.length === 0 || value.terms.length > MAX_TERMS) {
		throw new Error(`trigger.terms must contain 1-${MAX_TERMS} strings.`);
	}
	const terms = [...new Set(value.terms.map((term, index) => requiredString(term, `trigger.terms[${index}]`, MAX_TERM_LENGTH).toLowerCase()))];
	const match = value.match === undefined ? "any" : value.match;
	if (match !== "any" && match !== "all") throw new Error('trigger.match must be "any" or "all".');
	return { terms, match };
}

function parseManagedSkill(value: unknown): ManagedSkillProposal {
	if (!isRecord(value)) throw new Error("managedSkill must be an object.");
	assertExactKeys(value, SKILL_KEYS, "managedSkill");
	const rawName = requiredString(value.name, "managedSkill.name", 48);
	const name = sanitizeSkillName(rawName);
	if (name !== rawName) throw new Error("managedSkill.name must already be lowercase and normalized.");
	return {
		name,
		description: requiredString(value.description, "managedSkill.description", MAX_DESCRIPTION_LENGTH),
		body: requiredString(value.body, "managedSkill.body", MAX_SKILL_BODY_LENGTH),
	};
}

function parseRoute(value: unknown): RouteProposal {
	if (!isRecord(value)) throw new Error("route must be an object.");
	assertExactKeys(value, ROUTE_KEYS, "route");
	const model = requiredString(value.model, "route.model", 200);
	if (value.thinkingLevel !== undefined && !THINKING_LEVELS.has(value.thinkingLevel as PersonalizationThinkingLevel)) {
		throw new Error("route.thinkingLevel is invalid.");
	}
	return {
		model,
		...(value.thinkingLevel === undefined
			? {}
			: { thinkingLevel: value.thinkingLevel as PersonalizationThinkingLevel }),
	};
}

export function validatePersonalizationProposal(value: unknown): PersonalizationProposal {
	if (!isRecord(value)) throw new Error("proposal must be a JSON object.");
	assertExactKeys(value, TOP_LEVEL_KEYS, "proposal");
	if (!KINDS.has(value.kind as PersonalizationCandidateKind)) throw new Error("proposal.kind is invalid.");
	if (!SCOPES.has(value.scope as PersonalizationScope)) throw new Error("proposal.scope is invalid.");
	const kind = value.kind as PersonalizationCandidateKind;
	const scope = value.scope as PersonalizationScope;
	const title = requiredString(value.title, "proposal.title", MAX_TITLE_LENGTH);
	const trigger = parseTrigger(value.trigger);
	const evidenceValue = value.evidenceTrajectoryIds ?? [];
	if (!Array.isArray(evidenceValue) || evidenceValue.length > MAX_EVIDENCE) {
		throw new Error(`evidenceTrajectoryIds must be an array of at most ${MAX_EVIDENCE} ids.`);
	}
	const evidenceTrajectoryIds = [...new Set(evidenceValue.map((id, index) => {
		if (!Number.isSafeInteger(id) || (id as number) <= 0) {
			throw new Error(`evidenceTrajectoryIds[${index}] must be a positive integer.`);
		}
		return id as number;
	}))];

	if (kind === "instruction" || kind === "tool_guidance") {
		if (value.managedSkill !== undefined || value.route !== undefined) {
			throw new Error(`${kind} proposals only accept content.`);
		}
		return {
			kind,
			scope,
			title,
			trigger,
			content: requiredString(value.content, "proposal.content", MAX_CONTENT_LENGTH),
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
	const normalized = prompt.toLowerCase();
	return trigger.match === "all"
		? trigger.terms.every(term => normalized.includes(term))
		: trigger.terms.some(term => normalized.includes(term));
}
