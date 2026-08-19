export type PersonalizationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const PERSONALIZATION_TOOL_NAME = "propose_personalization";

export type PersonalizationCandidateKind = "instruction" | "tool_guidance" | "managed_skill" | "route";
export type PersonalizationScope = "project" | "global";
export type PersonalizationRisk = "low" | "high";
export type PersonalizationStatus = "pending" | "canary" | "active" | "rejected" | "rolled_back";
export type PersonalizationArm = "control" | "treatment" | "active";
export type PersonalizationActor = "system" | "user" | "model";
export type PersonalizationFeedback = "good" | "bad";

export interface PersonalizationTrigger {
	terms: string[];
	match: "any" | "all";
}

export interface ManagedSkillProposal {
	name: string;
	description: string;
	body: string;
}

export interface ManagedSkillArtifactIdentity {
	name: string;
	path: string;
	contentSha256: string;
	size: number;
	dev: number | null;
	ino: number | null;
}

export interface RouteProposal {
	model: string;
	thinkingLevel?: PersonalizationThinkingLevel;
}

export interface PersonalizationProposal {
	kind: PersonalizationCandidateKind;
	scope: PersonalizationScope;
	title: string;
	trigger: PersonalizationTrigger;
	content?: string;
	managedSkill?: ManagedSkillProposal;
	route?: RouteProposal;
	evidenceTrajectoryIds: number[];
}

export interface ResolvedPersonalizationProject {
	identity: string;
	root: string;
}

export interface ProjectRecord extends ResolvedPersonalizationProject {
	id: number;
}

export interface TrajectoryInput {
	projectId: number;
	promptPreview: string;
	promptHash: string;
	model: string | null;
	durationMs: number;
	sessionId: string;
	sessionRef: string | null;
	toolCount: number;
	errorCount: number;
	retryCount: number;
	deniedCount: number;
	utility: number;
}

export interface TrajectoryRecord extends TrajectoryInput {
	id: number;
	feedback: PersonalizationFeedback | null;
	feedbackNote: string | null;
	createdAt: number;
}

export interface CandidateRecord {
	id: number;
	projectId: number;
	kind: PersonalizationCandidateKind;
	scope: PersonalizationScope;
	title: string;
	status: PersonalizationStatus;
	risk: PersonalizationRisk;
	trigger: PersonalizationTrigger;
	content: string | null;
	managedSkill: ManagedSkillProposal | null;
	route: RouteProposal | null;
	managedSkillArtifact: ManagedSkillArtifactIdentity | null;
	autoPromoted: boolean;
	promotionBaselineUtility: number | null;
	promotionBaselineErrorRate: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface CandidateSourceInput {
	type: "user" | "model" | "trajectory";
	ref: string;
}

export interface EvaluationSettings {
	minEvidence: number;
	minEvaluationSamples: number;
	promotionMargin: number;
	regressionThreshold: number;
	autoPromoteLowRisk: boolean;
}

export interface OutcomeInput {
	candidateId: number;
	trajectoryId: number;
	arm: PersonalizationArm;
	utility: number;
	hadError: boolean;
}

export interface OutcomeRecord extends OutcomeInput {
	id: number;
	createdAt: number;
}

export interface ArmStatistics {
	arm: PersonalizationArm;
	samples: number;
	utility: number;
	errorRate: number;
}

export interface EvaluationDecision {
	candidateId: number;
	from: PersonalizationStatus;
	to: PersonalizationStatus;
	reason: string;
}

export interface CandidateTransitionOptions {
	actor: PersonalizationActor;
	reason: string;
	promotionBaselineUtility?: number;
	promotionBaselineErrorRate?: number;
	autoPromoted?: boolean;
}

export interface AuditRecord {
	id: number;
	projectId: number | null;
	candidateId: number | null;
	event: string;
	actor: PersonalizationActor;
	reason: string;
	details: Record<string, unknown> | null;
	fromStatus: PersonalizationStatus | null;
	toStatus: PersonalizationStatus | null;
	createdAt: number;
}

export interface TrajectoryScoreInput {
	completed: boolean;
	toolErrorCount: number;
	automaticRetryCount: number;
	deniedApprovalCount: number;
	explicitFeedback?: PersonalizationFeedback | null;
}

export interface TurnCandidateAssignment {
	candidate: CandidateRecord;
	arm: PersonalizationArm;
	applied: boolean;
}
