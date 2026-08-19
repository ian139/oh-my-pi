import { createHash } from "node:crypto";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { AgentSessionEvent } from "../session/agent-session";
import { PersonalizationStore, resolvePersonalizationProject } from "./store";
import type {
	CandidateRecord,
	CandidateSourceInput,
	EvaluationDecision,
	EvaluationSettings,
	OutcomeInput,
	PersonalizationArm,
	PersonalizationProposal,
	PersonalizationStatus,
	ProjectRecord,
	TrajectoryInput,
	TrajectoryRecord,
	TurnCandidateAssignment,
} from "./types";
import { matchesPersonalizationTrigger, validatePersonalizationProposal } from "./validation";

const PROMPT_PREVIEW_LIMIT = 500;
const DEFAULT_AUTOLEARN_MIN_TOOL_CALLS = 5;

export const PERSONALIZATION_UTILITY_WEIGHTS = Object.freeze({
	completed: 1,
	terminalFailure: 0.35,
	toolErrorPenalty: 0.15,
	retryPenalty: 0.1,
	deniedApprovalPenalty: 0.1,
});

export interface PersonalizationTrajectorySignals {
	completed: boolean;
	errorCount: number;
	retryCount: number;
	deniedCount: number;
}

export function clampUtility(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value === Number.POSITIVE_INFINITY) return 1;
	if (value === Number.NEGATIVE_INFINITY) return 0;
	return Math.min(1, Math.max(0, value));
}

export function scorePersonalizationTrajectory(signals: PersonalizationTrajectorySignals): number {
	const base = signals.completed
		? PERSONALIZATION_UTILITY_WEIGHTS.completed
		: PERSONALIZATION_UTILITY_WEIGHTS.terminalFailure;
	return clampUtility(
		base -
			Math.max(0, signals.errorCount) * PERSONALIZATION_UTILITY_WEIGHTS.toolErrorPenalty -
			Math.max(0, signals.retryCount) * PERSONALIZATION_UTILITY_WEIGHTS.retryPenalty -
			Math.max(0, signals.deniedCount) * PERSONALIZATION_UTILITY_WEIGHTS.deniedApprovalPenalty,
	);
}

export function assignPersonalizationArm(candidateId: number, stableTurnIdentity: string): Extract<PersonalizationArm, "control" | "treatment"> {
	const digest = createHash("sha256").update(`${candidateId}\0${stableTurnIdentity}`).digest();
	return (digest[0] & 1) === 0 ? "control" : "treatment";
}

export interface PersonalizationStoreAdapter {
	readonly persistent: boolean;
	close(): void;
	ensureProject(identity: string, root: string): ProjectRecord;
	prune(retentionDays: number): void;
	recordTrajectory(input: TrajectoryInput): TrajectoryRecord;
	getLatestTrajectory(projectId: number): TrajectoryRecord | null;
	setFeedback(trajectoryId: number, feedback: "good" | "bad", note: string | null): TrajectoryRecord;
	createCandidate(
		projectId: number,
		proposal: PersonalizationProposal,
		source: CandidateSourceInput,
		evidenceTrajectoryIds: number[],
	): CandidateRecord;
	getCandidate(id: number): CandidateRecord | null;
	listCandidates(projectId: number, statuses?: PersonalizationStatus[]): CandidateRecord[];
	countEvidence(candidateId: number): number;
	transition(
		id: number,
		to: PersonalizationStatus,
		reason: string | { actor: "user" | "system"; reason: string },
	): CandidateRecord;
	setArtifact?(id: number, name: string, content: string): void;
	recordOutcome(input: OutcomeInput): void;
	evaluateCandidate(candidateId: number, settings: EvaluationSettings): EvaluationDecision | null;
	recordAudit?(projectId: number, candidateId: number | null, event: string, details: Record<string, unknown>): void;
}

export interface PersonalizationManagedArtifact {
	name: string;
	path: string;
	contentSha256: string;
	dev?: number;
	ino?: number;
}

export interface PersonalizationManagedSkillAdapter {
	create(candidate: CandidateRecord): Promise<PersonalizationManagedArtifact>;
	delete(candidate: CandidateRecord): Promise<void>;
	deleteCreated?(artifact: PersonalizationManagedArtifact): Promise<void>;
}

export interface PersonalizationControllerOptions {
	settings: Settings;
	cwd: string;
	agentDir: string;
	getSessionId: () => string;
	getSessionRef?: () => string | null;
	getModelSelector?: () => string | null;
	isPlanMode?: () => boolean;
	isGoalMode?: () => boolean;
	storeFactory?: (dbPath: string) => PersonalizationStoreAdapter;
	projectResolver?: (cwd: string) => Promise<{ identity: string; root: string }>;
	managedSkills?: PersonalizationManagedSkillAdapter;
}

export interface PersonalizationProposalResult {
	candidate: CandidateRecord;
	evidenceCount: number;
}

export interface PersonalizationStatusSnapshot {
	enabled: boolean;
	storage: "unopened" | "persistent" | "memory-fallback";
	project: ProjectRecord | null;
	candidates: Record<PersonalizationStatus, number>;
	latestTrajectoryId: number | null;
}

interface ActiveTurn {
	promptPreview: string;
	promptHash: string;
	startedAt: number;
	model: string | null;
	toolCount: number;
	errorCount: number;
	retryCount: number;
	deniedCount: number;
	startedInPlanMode: boolean;
	startedInGoalMode: boolean;
	assignments: TurnCandidateAssignment[];
}

function lastAssistantStopReason(messages: unknown[]): string | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
			return "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : null;
		}
	}
	return null;
}

function emptyCandidateCounts(): Record<PersonalizationStatus, number> {
	return { pending: 0, canary: 0, active: 0, rejected: 0, rolled_back: 0 };
}

export class PersonalizationController {
	readonly #settings: Settings;
	readonly #cwd: string;
	readonly #agentDir: string;
	readonly #getSessionId: () => string;
	readonly #getSessionRef: () => string | null;
	readonly #getModelSelector: () => string | null;
	readonly #isPlanMode: () => boolean;
	readonly #isGoalMode: () => boolean;
	readonly #storeFactory: (dbPath: string) => PersonalizationStoreAdapter;
	readonly #projectResolver: (cwd: string) => Promise<{ identity: string; root: string }>;
	readonly #managedSkills: PersonalizationManagedSkillAdapter | undefined;
	#store: PersonalizationStoreAdapter | null = null;
	#project: ProjectRecord | null = null;
	#opening: Promise<void> | null = null;
	#activeTurn: ActiveTurn | null = null;
	#justRecordedTrajectory: { substantive: boolean; negative: boolean } | null = null;

	constructor(options: PersonalizationControllerOptions) {
		this.#settings = options.settings;
		this.#cwd = options.cwd;
		this.#agentDir = options.agentDir;
		this.#getSessionId = options.getSessionId;
		this.#getSessionRef = options.getSessionRef ?? (() => null);
		this.#getModelSelector = options.getModelSelector ?? (() => null);
		this.#isPlanMode = options.isPlanMode ?? (() => false);
		this.#isGoalMode = options.isGoalMode ?? (() => false);
		this.#storeFactory = options.storeFactory ?? (dbPath => PersonalizationStore.open(dbPath));
		this.#projectResolver = options.projectResolver ?? resolvePersonalizationProject;
		this.#managedSkills = options.managedSkills;
	}

	get enabled(): boolean {
		return this.#settings.get("personalization.enabled") === true;
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (!enabled) {
			this.#activeTurn = null;
			this.#justRecordedTrajectory = null;
			return;
		}
		await this.#ensureOpen();
	}

	async #ensureOpen(): Promise<void> {
		if (this.#store && this.#project) return;
		if (this.#opening) return await this.#opening;
		this.#opening = (async () => {
			const resolved = await this.#projectResolver(this.#cwd);
			const store = this.#storeFactory(getAgentDbPath(this.#agentDir));
			try {
				const project = store.ensureProject(resolved.identity, resolved.root);
				store.prune(this.#settings.get("personalization.retentionDays") ?? 30);
				this.#store = store;
				this.#project = project;
			} catch (error) {
				store.close();
				throw error;
			}
		})().finally(() => {
			this.#opening = null;
		});
		return await this.#opening;
	}

	async beginTurn(prompt: string): Promise<TurnCandidateAssignment[]> {
		this.#justRecordedTrajectory = null;
		if (!this.enabled) {
			this.#activeTurn = null;
			return [];
		}
		await this.#ensureOpen();
		const store = this.#requireStore();
		const project = this.#requireProject();
		const promptPreview = prompt.slice(0, PROMPT_PREVIEW_LIMIT);
		const promptHash = createHash("sha256").update(prompt).digest("hex");
		const turnIdentity = `${this.#getSessionId()}:${promptHash}`;
		const assignments = store
			.listCandidates(project.id, ["canary", "active"])
			.filter(candidate => matchesPersonalizationTrigger(candidate.trigger, prompt))
			.map((candidate): TurnCandidateAssignment => {
				const arm = candidate.status === "canary" ? assignPersonalizationArm(candidate.id, turnIdentity) : "active";
				return { candidate, arm, applied: arm !== "control" };
			});
		this.#activeTurn = {
			promptPreview,
			promptHash,
			startedAt: Date.now(),
			model: this.#getModelSelector(),
			toolCount: 0,
			errorCount: 0,
			retryCount: 0,
			deniedCount: 0,
			startedInPlanMode: this.#isPlanMode(),
			startedInGoalMode: this.#isGoalMode(),
			assignments,
		};
		return assignments;
	}

	markAssignmentNotApplied(candidateId: number): void {
		const assignment = this.#activeTurn?.assignments.find(item => item.candidate.id === candidateId);
		if (assignment) assignment.applied = false;
	}
	updateTurnModel(model: string): void {
		if (this.#activeTurn) this.#activeTurn.model = model;
	}


	recordDeniedApproval(): void {
		if (this.enabled && this.#activeTurn) this.#activeTurn.deniedCount++;
	}

	handleEvent(event: AgentSessionEvent): void {
		if (!this.enabled || !this.#activeTurn) return;
		if (event.type === "tool_execution_end") {
			this.#activeTurn.toolCount++;
			if (event.isError) this.#activeTurn.errorCount++;
			return;
		}
		if (event.type === "auto_retry_start") {
			this.#activeTurn.retryCount++;
			return;
		}
		if (event.type !== "agent_end") return;
		const turn = this.#activeTurn;
		this.#activeTurn = null;
		this.#justRecordedTrajectory = null;
		if (event.isTerminal === false) return;
		if (turn.startedInPlanMode || turn.startedInGoalMode || this.#isPlanMode() || this.#isGoalMode()) return;
		const stopReason = lastAssistantStopReason(event.messages);
		if (stopReason === "aborted" || stopReason === "toolUse" || stopReason === null) return;
		try {
			this.#recordTerminalTurn(turn, stopReason);
		} catch (error) {
			logger.warn("Failed to record personalization trajectory", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#recordTerminalTurn(turn: ActiveTurn, stopReason: string): void {
		const store = this.#requireStore();
		const project = this.#requireProject();
		const completed = stopReason !== "error";
		const utility = scorePersonalizationTrajectory({
			completed,
			errorCount: turn.errorCount,
			retryCount: turn.retryCount,
			deniedCount: turn.deniedCount,
		});
		const trajectory = store.recordTrajectory({
			projectId: project.id,
			promptPreview: turn.promptPreview,
			promptHash: turn.promptHash,
			model: turn.model,
			durationMs: Math.max(0, Date.now() - turn.startedAt),
			sessionId: this.#getSessionId(),
			sessionRef: this.#getSessionRef(),
			toolCount: turn.toolCount,
			errorCount: turn.errorCount,
			retryCount: turn.retryCount,
			deniedCount: turn.deniedCount,
			utility,
		});
		for (const assignment of turn.assignments) {
			if (!assignment.applied && assignment.arm !== "control") continue;
			store.recordOutcome({
				candidateId: assignment.candidate.id,
				trajectoryId: trajectory.id,
				arm: assignment.arm,
				utility,
				hadError: turn.errorCount > 0,
			});
			if (assignment.candidate.risk === "low") {
				store.evaluateCandidate(assignment.candidate.id, this.#evaluationSettings());
			}
		}
		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_AUTOLEARN_MIN_TOOL_CALLS;
		this.#justRecordedTrajectory = {
			substantive: turn.toolCount >= minToolCalls,
			negative: turn.errorCount > 0 || turn.retryCount > 0 || turn.deniedCount > 0 || !completed,
		};
	}

	getJustRecordedTrajectory(): { substantive: boolean; negative: boolean } | null {
		return this.#justRecordedTrajectory;
	}

	async propose(value: unknown, source: CandidateSourceInput): Promise<PersonalizationProposalResult> {
		if (!this.enabled) throw new Error("Personalization is disabled. Run /personalize on first.");
		await this.#ensureOpen();
		const proposal = validatePersonalizationProposal(value);
		const store = this.#requireStore();
		const project = this.#requireProject();
		let candidate = store.createCandidate(project.id, proposal, source, proposal.evidenceTrajectoryIds);
		store.evaluateCandidate(candidate.id, this.#evaluationSettings());
		candidate = store.getCandidate(candidate.id) ?? candidate;
		return { candidate, evidenceCount: store.countEvidence(candidate.id) };
	}

	async feedback(feedback: "good" | "bad", note: string | null): Promise<TrajectoryRecord> {
		if (!this.enabled) throw new Error("Personalization is disabled. Run /personalize on first.");
		await this.#ensureOpen();
		const store = this.#requireStore();
		const project = this.#requireProject();
		const latest = store.getLatestTrajectory(project.id);
		if (!latest) throw new Error("No completed personalization trajectory is available for feedback.");
		const updated = store.setFeedback(latest.id, feedback, note);
		for (const candidate of store.listCandidates(project.id, ["canary", "active"])) {
			if (candidate.risk === "low") store.evaluateCandidate(candidate.id, this.#evaluationSettings());
		}
		this.#justRecordedTrajectory = {
			substantive: updated.toolCount >= (this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_AUTOLEARN_MIN_TOOL_CALLS),
			negative: feedback === "bad" || updated.errorCount > 0 || updated.retryCount > 0 || updated.deniedCount > 0,
		};
		return updated;
	}

	async listCandidates(statuses?: PersonalizationStatus[]): Promise<CandidateRecord[]> {
		if (!this.enabled) return [];
		await this.#ensureOpen();
		return this.#requireStore().listCandidates(this.#requireProject().id, statuses);
	}

	async getCandidate(id: number): Promise<CandidateRecord> {
		if (!this.enabled) throw new Error("Personalization is disabled. Run /personalize on first.");
		await this.#ensureOpen();
		return this.#getCandidateForProject(id);
	}

	async approve(id: number): Promise<CandidateRecord> {
		await this.#ensureOpen();
		const store = this.#requireStore();
		const candidate = this.#getCandidateForProject(id);
		if (candidate.status !== "pending" && candidate.status !== "canary") {
			throw new Error(`Candidate ${id} cannot be approved from ${candidate.status}; review an active pending or canary candidate.`);
		}
		let artifact: PersonalizationManagedArtifact | null = null;
		if (candidate.kind === "managed_skill") {
			if (!this.#managedSkills) throw new Error("Managed-skill personalization is unavailable in this session.");
			artifact = await this.#managedSkills.create(candidate);
			store.setArtifact?.(candidate.id, artifact.name, JSON.stringify(artifact));
		}
		try {
			return store.transition(candidate.id, "active", { actor: "user", reason: "approved by user" });
		} catch (error) {
			if (artifact && this.#managedSkills?.deleteCreated) {
				try {
					await this.#managedSkills.deleteCreated(artifact);
				} catch (compensationError) {
					throw new Error(
						`Candidate activation failed and exact compensation could not remove ${artifact.path}: ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
						{ cause: error },
					);
				}
			}
			throw error;
		}
	}

	async reject(id: number, reason: string | null): Promise<CandidateRecord> {
		await this.#ensureOpen();
		const candidate = this.#getCandidateForProject(id);
		if (candidate.status !== "pending" && candidate.status !== "canary") {
			throw new Error(`Candidate ${id} cannot be rejected from ${candidate.status}; only pending or canary candidates can be rejected.`);
		}
		return this.#requireStore().transition(candidate.id, "rejected", {
			actor: "user",
			reason: reason?.trim() || "rejected by user",
		});
	}

	async rollback(id: number): Promise<CandidateRecord> {
		await this.#ensureOpen();
		const candidate = this.#getCandidateForProject(id);
		if (candidate.status !== "active") {
			throw new Error(`Candidate ${id} cannot be rolled back from ${candidate.status}; only active candidates can be rolled back.`);
		}
		if (candidate.kind === "managed_skill") {
			if (!this.#managedSkills) throw new Error("Managed-skill rollback is unavailable in this session.");
			try {
				await this.#managedSkills.delete(candidate);
			} catch (error) {
				this.#requireStore().recordAudit?.(candidate.projectId, candidate.id, "rollback_failed", {
					reason: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		}
		return this.#requireStore().transition(candidate.id, "rolled_back", {
			actor: "user",
			reason: "rolled back by user",
		});
	}

	async status(): Promise<PersonalizationStatusSnapshot> {
		if (!this.enabled) {
			const counts = emptyCandidateCounts();
			if (this.#store && this.#project) {
				for (const candidate of this.#store.listCandidates(this.#project.id)) counts[candidate.status]++;
			}
			return {
				enabled: false,
				storage: this.#store ? (this.#store.persistent ? "persistent" : "memory-fallback") : "unopened",
				project: this.#project,
				candidates: counts,
				latestTrajectoryId:
					this.#store && this.#project ? (this.#store.getLatestTrajectory(this.#project.id)?.id ?? null) : null,
			};
		}
		await this.#ensureOpen();
		const store = this.#requireStore();
		const project = this.#requireProject();
		const counts = emptyCandidateCounts();
		for (const candidate of store.listCandidates(project.id)) counts[candidate.status]++;
		return {
			enabled: true,
			storage: store.persistent ? "persistent" : "memory-fallback",
			project,
			candidates: counts,
			latestTrajectoryId: store.getLatestTrajectory(project.id)?.id ?? null,
		};
	}

	recordRouteShadow(winner: CandidateRecord, shadowed: CandidateRecord[]): void {
		if (shadowed.length === 0 || !this.#store) return;
		this.#store.recordAudit?.(winner.projectId, winner.id, "route_shadowed", {
			shadowedCandidateIds: shadowed.map(candidate => candidate.id),
		});
	}

	close(): void {
		this.#activeTurn = null;
		this.#store?.close();
		this.#store = null;
		this.#project = null;
	}

	#evaluationSettings(): EvaluationSettings {
		return {
			minEvidence: this.#settings.get("personalization.minEvidence") ?? 2,
			minEvaluationSamples: this.#settings.get("personalization.minEvaluationSamples") ?? 3,
			promotionMargin: this.#settings.get("personalization.promotionMargin") ?? 0.1,
			regressionThreshold: this.#settings.get("personalization.regressionThreshold") ?? 0.15,
			autoPromoteLowRisk: this.#settings.get("personalization.autoPromoteLowRisk") ?? true,
		};
	}

	#getCandidateForProject(id: number): CandidateRecord {
		const candidate = this.#requireStore().getCandidate(id);
		const project = this.#requireProject();
		if (!candidate || (candidate.projectId !== project.id && candidate.scope !== "global")) {
			throw new Error(`Candidate ${id} was not found in this project.`);
		}
		return candidate;
	}

	#requireStore(): PersonalizationStoreAdapter {
		if (!this.#store) throw new Error("Personalization storage is not initialized.");
		return this.#store;
	}

	#requireProject(): ProjectRecord {
		if (!this.#project) throw new Error("Personalization project is not initialized.");
		return this.#project;
	}
}
