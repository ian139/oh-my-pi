import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, getDbBusyTimeoutMs, isRecord, logger, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type {
	ArmStatistics,
	AuditRecord,
	CandidateRecord,
	CandidateSourceInput,
	CandidateTransitionOptions,
	EvaluationDecision,
	EvaluationSettings,
	ManagedSkillArtifactIdentity,
	OutcomeInput,
	PersonalizationActor,
	PersonalizationArm,
	PersonalizationProposal,
	PersonalizationStatus,
	ProjectRecord,
	ResolvedPersonalizationProject,
	TrajectoryInput,
	TrajectoryRecord,
} from "./types";
import {
	decidePersonalizationEvaluation,
	isLowRiskProposal,
	PERSONALIZATION_LIMITS,
	validatePersonalizationProposal,
} from "./validation";

export const PERSONALIZATION_SCHEMA_VERSION = 1;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";
const MAX_PROMPT_PREVIEW_LENGTH = 512;
const MAX_PROMPT_HASH_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_REF_LENGTH = 1_024;
const MAX_SOURCE_REF_LENGTH = 1_024;
const MAX_FEEDBACK_NOTE_LENGTH = 1_000;
const MAX_AUDIT_REASON_LENGTH = 1_000;
const MAX_AUDIT_DETAILS_LENGTH = 8_000;
const warnedFallbackPaths = new Set<string>();

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS personalization_projects (
	id INTEGER PRIMARY KEY,
	identity TEXT NOT NULL UNIQUE,
	root TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	last_seen_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;

CREATE TABLE IF NOT EXISTS personalization_trajectories (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES personalization_projects(id) ON DELETE CASCADE,
	prompt_preview TEXT NOT NULL,
	prompt_hash TEXT NOT NULL,
	model TEXT,
	duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
	session_id TEXT NOT NULL,
	session_ref TEXT,
	tool_count INTEGER NOT NULL CHECK(tool_count >= 0),
	error_count INTEGER NOT NULL CHECK(error_count >= 0),
	retry_count INTEGER NOT NULL CHECK(retry_count >= 0),
	denied_count INTEGER NOT NULL CHECK(denied_count >= 0),
	feedback TEXT CHECK(feedback IN ('good', 'bad')),
	feedback_note TEXT,
	utility REAL NOT NULL CHECK(utility >= 0 AND utility <= 1),
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;
CREATE INDEX IF NOT EXISTS personalization_trajectories_project_created
	ON personalization_trajectories(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS personalization_candidates (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES personalization_projects(id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK(kind IN ('instruction', 'tool_guidance', 'managed_skill', 'route')),
	scope TEXT NOT NULL CHECK(scope IN ('project', 'global')),
	title TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('pending', 'canary', 'active', 'rejected', 'rolled_back')),
	risk TEXT NOT NULL CHECK(risk IN ('low', 'high')),
	proposal_json TEXT NOT NULL,
	managed_skill_artifact_json TEXT,
	auto_promoted INTEGER NOT NULL DEFAULT 0 CHECK(auto_promoted IN (0, 1)),
	promotion_baseline_utility REAL CHECK(promotion_baseline_utility IS NULL OR (promotion_baseline_utility >= 0 AND promotion_baseline_utility <= 1)),
	promotion_baseline_error_rate REAL CHECK(promotion_baseline_error_rate IS NULL OR (promotion_baseline_error_rate >= 0 AND promotion_baseline_error_rate <= 1)),
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;
CREATE INDEX IF NOT EXISTS personalization_candidates_project_status
	ON personalization_candidates(project_id, status, id);

CREATE TABLE IF NOT EXISTS personalization_candidate_sources (
	id INTEGER PRIMARY KEY,
	candidate_id INTEGER NOT NULL REFERENCES personalization_candidates(id) ON DELETE CASCADE,
	source_type TEXT NOT NULL CHECK(source_type IN ('user', 'model', 'trajectory')),
	source_ref TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	UNIQUE(candidate_id, source_type, source_ref)
) STRICT;
CREATE INDEX IF NOT EXISTS personalization_candidate_sources_candidate
	ON personalization_candidate_sources(candidate_id);

CREATE TABLE IF NOT EXISTS personalization_outcomes (
	id INTEGER PRIMARY KEY,
	candidate_id INTEGER NOT NULL REFERENCES personalization_candidates(id) ON DELETE CASCADE,
	trajectory_id INTEGER NOT NULL REFERENCES personalization_trajectories(id) ON DELETE CASCADE,
	arm TEXT NOT NULL CHECK(arm IN ('control', 'treatment', 'active')),
	utility REAL NOT NULL CHECK(utility >= 0 AND utility <= 1),
	had_error INTEGER NOT NULL CHECK(had_error IN (0, 1)),
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	UNIQUE(candidate_id, trajectory_id, arm)
) STRICT;
CREATE INDEX IF NOT EXISTS personalization_outcomes_candidate_arm
	ON personalization_outcomes(candidate_id, arm, created_at DESC);

CREATE TABLE IF NOT EXISTS personalization_audit (
	id INTEGER PRIMARY KEY,
	project_id INTEGER REFERENCES personalization_projects(id) ON DELETE SET NULL,
	candidate_id INTEGER REFERENCES personalization_candidates(id) ON DELETE SET NULL,
	event TEXT NOT NULL,
	actor TEXT NOT NULL CHECK(actor IN ('system', 'user', 'model')),
	reason TEXT NOT NULL,
	details_json TEXT,
	from_status TEXT CHECK(from_status IS NULL OR from_status IN ('pending', 'canary', 'active', 'rejected', 'rolled_back')),
	to_status TEXT CHECK(to_status IS NULL OR to_status IN ('pending', 'canary', 'active', 'rejected', 'rolled_back')),
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;
CREATE INDEX IF NOT EXISTS personalization_audit_candidate_created
	ON personalization_audit(candidate_id, created_at DESC);
`;

type ProjectRow = { id: number; identity: string; root: string };
type TrajectoryRow = {
	id: number;
	project_id: number;
	prompt_preview: string;
	prompt_hash: string;
	model: string | null;
	duration_ms: number;
	session_id: string;
	session_ref: string | null;
	tool_count: number;
	error_count: number;
	retry_count: number;
	denied_count: number;
	feedback: "good" | "bad" | null;
	feedback_note: string | null;
	utility: number;
	created_at: number;
};
type CandidateRow = {
	id: number;
	project_id: number;
	kind: CandidateRecord["kind"];
	scope: CandidateRecord["scope"];
	title: string;
	status: PersonalizationStatus;
	risk: CandidateRecord["risk"];
	proposal_json: string;
	managed_skill_artifact_json: string | null;
	auto_promoted: number;
	promotion_baseline_utility: number | null;
	promotion_baseline_error_rate: number | null;
	created_at: number;
	updated_at: number;
};
type ArmStatsRow = { arm: PersonalizationArm; samples: number; utility: number; error_rate: number };
type AuditRow = {
	id: number;
	project_id: number | null;
	candidate_id: number | null;
	event: string;
	actor: PersonalizationActor;
	reason: string;
	details_json: string | null;
	from_status: PersonalizationStatus | null;
	to_status: PersonalizationStatus | null;
	created_at: number;
};

function boundedString(value: string, label: string, maximum: number): string {
	if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters.`);
	return value;
}

function finiteUtility(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
	return Math.min(1, Math.max(0, value));
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
	return Math.max(0, Math.floor(value));
}

function parseManagedSkillArtifact(value: string | null): ManagedSkillArtifactIdentity | null {
	if (value === null) return null;
	const parsed: unknown = JSON.parse(value);
	if (!isRecord(parsed)) throw new Error("Stored managed-skill artifact identity is invalid.");
	const keys = Object.keys(parsed);
	const expected = ["contentSha256", "dev", "ino", "name", "path", "size"];
	if (keys.length !== expected.length || keys.sort().some((key, index) => key !== expected[index])) {
		throw new Error("Stored managed-skill artifact identity contains unsupported fields.");
	}
	if (
		typeof parsed.name !== "string" ||
		typeof parsed.path !== "string" ||
		typeof parsed.contentSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(parsed.contentSha256) ||
		!Number.isSafeInteger(parsed.size) ||
		(parsed.size as number) < 0 ||
		(parsed.dev !== null && !Number.isSafeInteger(parsed.dev)) ||
		(parsed.ino !== null && !Number.isSafeInteger(parsed.ino))
	) {
		throw new Error("Stored managed-skill artifact identity is invalid.");
	}
	return {
		name: parsed.name,
		path: parsed.path,
		contentSha256: parsed.contentSha256,
		size: parsed.size as number,
		dev: parsed.dev as number | null,
		ino: parsed.ino as number | null,
	};
}

function decodeTrajectory(row: TrajectoryRow): TrajectoryRecord {
	return {
		id: row.id,
		projectId: row.project_id,
		promptPreview: row.prompt_preview,
		promptHash: row.prompt_hash,
		model: row.model,
		durationMs: row.duration_ms,
		sessionId: row.session_id,
		sessionRef: row.session_ref,
		toolCount: row.tool_count,
		errorCount: row.error_count,
		retryCount: row.retry_count,
		deniedCount: row.denied_count,
		feedback: row.feedback,
		feedbackNote: row.feedback_note,
		utility: row.utility,
		createdAt: row.created_at,
	};
}

function decodeCandidate(row: CandidateRow): CandidateRecord {
	const proposal = validatePersonalizationProposal(JSON.parse(row.proposal_json));
	return {
		id: row.id,
		projectId: row.project_id,
		kind: row.kind,
		scope: row.scope,
		title: row.title,
		status: row.status,
		risk: row.risk,
		trigger: proposal.trigger,
		content: proposal.content ?? null,
		managedSkill: proposal.managedSkill ?? null,
		route: proposal.route ?? null,
		managedSkillArtifact: parseManagedSkillArtifact(row.managed_skill_artifact_json),
		autoPromoted: row.auto_promoted === 1,
		promotionBaselineUtility: row.promotion_baseline_utility,
		promotionBaselineErrorRate: row.promotion_baseline_error_rate,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function decodeAudit(row: AuditRow): AuditRecord {
	return {
		id: row.id,
		projectId: row.project_id,
		candidateId: row.candidate_id,
		event: row.event,
		actor: row.actor,
		reason: row.reason,
		details: row.details_json === null ? null : (JSON.parse(row.details_json) as Record<string, unknown>),
		fromStatus: row.from_status,
		toStatus: row.to_status,
		createdAt: row.created_at,
	};
}

function assertTransition(from: PersonalizationStatus, to: PersonalizationStatus): void {
	const allowed: Record<PersonalizationStatus, readonly PersonalizationStatus[]> = {
		pending: ["canary", "active", "rejected"],
		canary: ["active", "rejected"],
		active: ["rolled_back"],
		rejected: [],
		rolled_back: [],
	};
	if (!allowed[from].includes(to)) throw new Error(`Invalid personalization transition ${from} -> ${to}.`);
}

export async function resolvePersonalizationProject(cwd: string): Promise<ResolvedPersonalizationProject> {
	const absoluteCwd = path.resolve(cwd);
	const primaryRoot = await git.repo.primaryRoot(absoluteCwd);
	const root = normalizePathForComparison(path.resolve(primaryRoot ?? absoluteCwd));
	return {
		identity: createHash("sha256").update(root).digest("hex"),
		root,
	};
}

export class PersonalizationStore {
	readonly #db: Database;
	readonly persistent: boolean;
	readonly fallbackReason: string | null;

	private constructor(db: Database, persistent: boolean, fallbackReason: string | null) {
		this.#db = db;
		this.persistent = persistent;
		this.fallbackReason = fallbackReason;
	}

	static openForAgent(agentDir: string): PersonalizationStore {
		return PersonalizationStore.open(getAgentDbPath(agentDir));
	}

	static open(dbPath: string): PersonalizationStore {
		let db: Database | undefined;
		try {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
			db = new Database(dbPath);
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			PersonalizationStore.#initialize(db);
			return new PersonalizationStore(db, true, null);
		} catch (error) {
			try {
				db?.close();
			} catch {
				// Preserve the primary open error; the fallback is independent.
			}
			const fallbackReason = error instanceof Error ? error.message : String(error);
			if (!warnedFallbackPaths.has(dbPath)) {
				warnedFallbackPaths.add(dbPath);
				logger.warn("Personalization database unavailable; using in-memory storage", { dbPath, error: fallbackReason });
			}
			const memoryDb = new Database(":memory:");
			memoryDb.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			PersonalizationStore.#initialize(memoryDb);
			return new PersonalizationStore(memoryDb, false, fallbackReason);
		}
	}

	static #initialize(db: Database): void {
		const schemaExists = db
			.query<{ present: number }, []>(
				"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'personalization_schema'",
			)
			.get();
		if (schemaExists) {
			const existing = db
				.query<{ version: number }, []>("SELECT version FROM personalization_schema WHERE singleton = 1")
				.get();
			if (!existing || existing.version !== PERSONALIZATION_SCHEMA_VERSION) {
				throw new Error(
					`Personalization schema ${existing?.version ?? "missing"} does not match supported version ${PERSONALIZATION_SCHEMA_VERSION}.`,
				);
			}
		}
		db.run("PRAGMA journal_mode=WAL");
		db.run("PRAGMA synchronous=NORMAL");
		db.run("PRAGMA foreign_keys=ON");
		db.run(`CREATE TABLE IF NOT EXISTS personalization_schema (
			singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
			version INTEGER NOT NULL
		) STRICT`);
		db.query("INSERT OR IGNORE INTO personalization_schema(singleton, version) VALUES (1, ?)").run(
			PERSONALIZATION_SCHEMA_VERSION,
		);
		const row = db.query<{ version: number }, []>("SELECT version FROM personalization_schema WHERE singleton = 1").get();
		if (!row || row.version !== PERSONALIZATION_SCHEMA_VERSION) {
			throw new Error(
				`Personalization schema ${row?.version ?? "missing"} does not match supported version ${PERSONALIZATION_SCHEMA_VERSION}.`,
			);
		}
		db.run(TABLES_SQL);
	}

	close(): void {
		this.#db.close();
	}

	ensureProject(identity: string, root: string): ProjectRecord {
		const safeIdentity = boundedString(identity, "project identity", 128);
		const safeRoot = boundedString(root, "project root", 4_096);
		if (!safeIdentity || !safeRoot) throw new Error("Project identity and root must not be empty.");
		this.#db
			.query(`INSERT INTO personalization_projects(identity, root) VALUES (?, ?)
				ON CONFLICT(identity) DO UPDATE SET root = excluded.root, last_seen_at = ${SQLITE_NOW_EPOCH}`)
			.run(safeIdentity, safeRoot);
		const row = this.#db
			.query<ProjectRow, [string]>("SELECT id, identity, root FROM personalization_projects WHERE identity = ?")
			.get(safeIdentity);
		if (!row) throw new Error("Failed to persist personalization project identity.");
		return row;
	}

	prune(retentionDays: number): number {
		const days = Math.max(1, Math.floor(retentionDays));
		const cutoff = Math.floor(Date.now() / 1_000) - days * 86_400;
		return this.#db.transaction(() => {
			const result = this.#db.query("DELETE FROM personalization_trajectories WHERE created_at < ?").run(cutoff);
			return result.changes;
		})();
	}

	recordTrajectory(input: TrajectoryInput): TrajectoryRecord {
		const promptPreview = boundedString(input.promptPreview, "promptPreview", MAX_PROMPT_PREVIEW_LENGTH);
		const promptHash = boundedString(input.promptHash, "promptHash", MAX_PROMPT_HASH_LENGTH);
		const model = input.model === null ? null : boundedString(input.model, "model", PERSONALIZATION_LIMITS.model);
		const sessionId = boundedString(input.sessionId, "sessionId", MAX_SESSION_ID_LENGTH);
		const sessionRef = input.sessionRef === null ? null : boundedString(input.sessionRef, "sessionRef", MAX_SESSION_REF_LENGTH);
		const result = this.#db
			.query(`INSERT INTO personalization_trajectories(
				project_id, prompt_preview, prompt_hash, model, duration_ms, session_id, session_ref,
				tool_count, error_count, retry_count, denied_count, utility
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
			.get(
				input.projectId,
				promptPreview,
				promptHash,
				model,
				nonNegativeInteger(input.durationMs, "durationMs"),
				sessionId,
				sessionRef,
				nonNegativeInteger(input.toolCount, "toolCount"),
				nonNegativeInteger(input.errorCount, "errorCount"),
				nonNegativeInteger(input.retryCount, "retryCount"),
				nonNegativeInteger(input.deniedCount, "deniedCount"),
				finiteUtility(input.utility, "utility"),
			) as TrajectoryRow | null;
		if (!result) throw new Error("Failed to record personalization trajectory.");
		return decodeTrajectory(result);
	}

	getLatestTrajectory(projectId: number): TrajectoryRecord | null {
		const row = this.#db
			.query<TrajectoryRow, [number]>(
				"SELECT * FROM personalization_trajectories WHERE project_id = ? ORDER BY id DESC LIMIT 1",
			)
			.get(projectId);
		return row ? decodeTrajectory(row) : null;
	}

	listRecentTrajectoryIds(projectId: number, limit: number): number[] {
		return this.#db
			.query<{ id: number }, [number, number]>(
				"SELECT id FROM personalization_trajectories WHERE project_id = ? ORDER BY id DESC LIMIT ?",
			)
			.all(projectId, nonNegativeInteger(limit, "limit"))
			.map(row => row.id);
	}

	setFeedback(trajectoryId: number, feedback: "good" | "bad", note: string | null): TrajectoryRecord {
		const safeNote = note === null ? null : boundedString(note, "feedback note", MAX_FEEDBACK_NOTE_LENGTH);
		const utility = feedback === "good" ? 1 : 0;
		const row = this.#db.transaction(() => {
			const updated = this.#db
				.query(`UPDATE personalization_trajectories
					SET feedback = ?, feedback_note = ?, utility = ? WHERE id = ? RETURNING *`)
				.get(feedback, safeNote, utility, trajectoryId) as TrajectoryRow | null;
			if (!updated) throw new Error(`Trajectory ${trajectoryId} was not found.`);
			this.#db.query("UPDATE personalization_outcomes SET utility = ? WHERE trajectory_id = ?").run(utility, trajectoryId);
			return updated;
		})();
		return decodeTrajectory(row);
	}

	createCandidate(
		projectId: number,
		proposal: PersonalizationProposal,
		source: CandidateSourceInput,
		evidenceTrajectoryIds: number[] = proposal.evidenceTrajectoryIds,
	): CandidateRecord {
		const validated = validatePersonalizationProposal({ ...proposal, evidenceTrajectoryIds });
		const risk = isLowRiskProposal(validated) ? "low" : "high";
		const row = this.#db.transaction(() => {
			const inserted = this.#db
				.query(`INSERT INTO personalization_candidates(project_id, kind, scope, title, status, risk, proposal_json)
					VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING *`)
				.get(projectId, validated.kind, validated.scope, validated.title, risk, JSON.stringify(validated)) as CandidateRow | null;
			if (!inserted) throw new Error("Failed to create personalization candidate.");
			this.#insertSource(inserted.id, projectId, source);
			for (const trajectoryId of validated.evidenceTrajectoryIds) {
				this.#assertTrajectoryProject(trajectoryId, projectId, "Evidence trajectory");
				this.#insertSource(inserted.id, projectId, { type: "trajectory", ref: String(trajectoryId) });
			}
			this.#insertAudit(projectId, inserted.id, "candidate_created", source.type === "user" ? "user" : "model", "candidate created", {
				kind: validated.kind,
				scope: validated.scope,
				risk,
			});
			return inserted;
		})();
		return decodeCandidate(row);
	}

	#assertTrajectoryProject(trajectoryId: number, projectId: number, label: string): void {
		const exists = this.#db
			.query<{ id: number }, [number, number]>(
				"SELECT id FROM personalization_trajectories WHERE id = ? AND project_id = ?",
			)
			.get(trajectoryId, projectId);
		if (!exists) throw new Error(`${label} ${trajectoryId} does not belong to this project.`);
	}

	#insertSource(candidateId: number, projectId: number, source: CandidateSourceInput): boolean {
		const sourceRef = boundedString(source.ref, "candidate source reference", MAX_SOURCE_REF_LENGTH);
		if (!sourceRef) throw new Error("Candidate source reference must not be empty.");
		if (source.type === "trajectory") {
			const trajectoryId = Number(sourceRef);
			if (!Number.isSafeInteger(trajectoryId) || trajectoryId <= 0) throw new Error("Trajectory source reference is invalid.");
			this.#assertTrajectoryProject(trajectoryId, projectId, "Source trajectory");
		}
		const result = this.#db
			.query(`INSERT OR IGNORE INTO personalization_candidate_sources(candidate_id, source_type, source_ref)
				VALUES (?, ?, ?)`)
			.run(candidateId, source.type, sourceRef);
		if (result.changes === 0) return false;
		this.#insertAudit(projectId, candidateId, "source_added", source.type === "user" ? "user" : "model", "candidate source added", {
			type: source.type,
			ref: sourceRef,
		});
		return true;
	}

	addTrajectorySource(candidateId: number, trajectoryId: number): boolean {
		return this.#db.transaction(() => {
			const candidate = this.getCandidate(candidateId);
			if (!candidate) throw new Error(`Candidate ${candidateId} was not found.`);
			this.#assertTrajectoryProject(trajectoryId, candidate.projectId, "Evidence trajectory");
			return this.#insertSource(candidateId, candidate.projectId, { type: "trajectory", ref: String(trajectoryId) });
		})();
	}

	getCandidate(id: number): CandidateRecord | null {
		const row = this.#db.query<CandidateRow, [number]>("SELECT * FROM personalization_candidates WHERE id = ?").get(id);
		return row ? decodeCandidate(row) : null;
	}

	listCandidates(projectId: number, statuses?: PersonalizationStatus[]): CandidateRecord[] {
		const rows = statuses && statuses.length > 0
			? this.#db
					.query<CandidateRow, [number, ...PersonalizationStatus[]]>(
						`SELECT * FROM personalization_candidates
						 WHERE (project_id = ? OR scope = 'global')
						 AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`,
					)
					.all(projectId, ...statuses)
			: this.#db
					.query<CandidateRow, [number]>(
						"SELECT * FROM personalization_candidates WHERE project_id = ? OR scope = 'global' ORDER BY id",
					)
					.all(projectId);
		return rows.map(decodeCandidate);
	}

	countEvidence(candidateId: number): number {
		return (
			this.#db
				.query<{ count: number }, [number]>(
					"SELECT COUNT(*) AS count FROM personalization_candidate_sources WHERE candidate_id = ? AND source_type = 'trajectory'",
				)
				.get(candidateId)?.count ?? 0
		);
	}

	transition(
		id: number,
		to: PersonalizationStatus,
		reasonOrOptions: string | CandidateTransitionOptions,
		actor: PersonalizationActor = "system",
	): CandidateRecord {
		const options: CandidateTransitionOptions =
			typeof reasonOrOptions === "string" ? { actor, reason: reasonOrOptions } : reasonOrOptions;
		const reason = boundedString(options.reason, "transition reason", MAX_AUDIT_REASON_LENGTH);
		if (!reason) throw new Error("Transition reason must not be empty.");
		return this.#db.transaction(() => {
			const current = this.getCandidate(id);
			if (!current) throw new Error(`Candidate ${id} was not found.`);
			assertTransition(current.status, to);
			const autoPromoted = to === "active" ? (options.autoPromoted ?? false) : current.autoPromoted;
			const baselineUtility =
				to === "active" ? (options.promotionBaselineUtility ?? null) : current.promotionBaselineUtility;
			const baselineErrorRate =
				to === "active" ? (options.promotionBaselineErrorRate ?? null) : current.promotionBaselineErrorRate;
			const row = this.#db
				.query(`UPDATE personalization_candidates SET
					status = ?, auto_promoted = ?, promotion_baseline_utility = ?, promotion_baseline_error_rate = ?,
					updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? RETURNING *`)
				.get(
					to,
					autoPromoted ? 1 : 0,
					baselineUtility === null ? null : finiteUtility(baselineUtility, "promotion baseline utility"),
					baselineErrorRate === null ? null : finiteUtility(baselineErrorRate, "promotion baseline error rate"),
					id,
				) as CandidateRow | null;
			if (!row) throw new Error(`Candidate ${id} disappeared during transition.`);
			this.#insertAudit(current.projectId, id, "transition", options.actor, reason, null, current.status, to);
			return decodeCandidate(row);
		})();
	}

	setManagedSkillArtifact(id: number, artifact: ManagedSkillArtifactIdentity | null): CandidateRecord {
		const artifactJson = artifact === null ? null : JSON.stringify(artifact);
		if (artifactJson !== null) parseManagedSkillArtifact(artifactJson);
		const row = this.#db
			.query(`UPDATE personalization_candidates SET managed_skill_artifact_json = ?, updated_at = ${SQLITE_NOW_EPOCH}
				WHERE id = ? RETURNING *`)
			.get(artifactJson, id) as CandidateRow | null;
		if (!row) throw new Error(`Candidate ${id} was not found.`);
		return decodeCandidate(row);
	}

	recordOutcome(input: OutcomeInput): void {
		this.#db.transaction(() => {
			const candidate = this.getCandidate(input.candidateId);
			if (!candidate) throw new Error(`Candidate ${input.candidateId} was not found.`);
			this.#assertTrajectoryProject(input.trajectoryId, candidate.projectId, "Outcome trajectory");
			this.#db
				.query(`INSERT INTO personalization_outcomes(candidate_id, trajectory_id, arm, utility, had_error)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(candidate_id, trajectory_id, arm)
					DO UPDATE SET utility = excluded.utility, had_error = excluded.had_error`)
				.run(
					input.candidateId,
					input.trajectoryId,
					input.arm,
					finiteUtility(input.utility, "outcome utility"),
					input.hadError ? 1 : 0,
				);
		})();
	}

	getOutcomeStats(candidateId: number): Map<PersonalizationArm, ArmStatistics> {
		const rows = this.#db
			.query<ArmStatsRow, [number]>(`SELECT arm, COUNT(*) AS samples, AVG(utility) AS utility, AVG(had_error) AS error_rate
				FROM personalization_outcomes WHERE candidate_id = ? GROUP BY arm`)
			.all(candidateId);
		return new Map(
			rows.map(row => [
				row.arm,
				{ arm: row.arm, samples: row.samples, utility: row.utility, errorRate: row.error_rate },
			]),
		);
	}

	seedControlBaseline(candidateId: number, projectId: number, limit: number): void {
		const rows = this.#db
			.query<{ id: number; utility: number; error_count: number }, [number, number]>(
				"SELECT id, utility, error_count FROM personalization_trajectories WHERE project_id = ? ORDER BY id DESC LIMIT ?",
			)
			.all(projectId, Math.max(1, nonNegativeInteger(limit, "limit")));
		for (const row of rows) {
			this.recordOutcome({
				candidateId,
				trajectoryId: row.id,
				arm: "control",
				utility: row.utility,
				hadError: row.error_count > 0,
			});
		}
	}

	evaluateCandidate(candidateId: number, settings: EvaluationSettings): EvaluationDecision | null {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) return null;
		const stats = this.getOutcomeStats(candidateId);
		const decision = decidePersonalizationEvaluation(candidate, this.countEvidence(candidateId), stats, settings);
		if (!decision) return null;
		if (decision.to === "active") {
			const control = stats.get("control");
			if (!control) return null;
			this.transition(candidateId, "active", {
				actor: "system",
				reason: decision.reason,
				autoPromoted: true,
				promotionBaselineUtility: control.utility,
				promotionBaselineErrorRate: control.errorRate,
			});
		} else {
			this.transition(candidateId, decision.to, { actor: "system", reason: decision.reason });
		}
		return decision;
	}

	recordAudit(
		projectId: number | null,
		candidateId: number | null,
		event: string,
		details: Record<string, unknown> | null = null,
		options: { actor?: PersonalizationActor; reason?: string } = {},
	): AuditRecord {
		return this.#insertAudit(
			projectId,
			candidateId,
			boundedString(event, "audit event", 120),
			options.actor ?? "system",
			boundedString(options.reason ?? event, "audit reason", MAX_AUDIT_REASON_LENGTH),
			details,
		);
	}

	listAudit(candidateId: number): AuditRecord[] {
		return this.#db
			.query<AuditRow, [number]>(
				"SELECT * FROM personalization_audit WHERE candidate_id = ? ORDER BY id",
			)
			.all(candidateId)
			.map(decodeAudit);
	}

	#insertAudit(
		projectId: number | null,
		candidateId: number | null,
		event: string,
		actor: PersonalizationActor,
		reason: string,
		details: Record<string, unknown> | null,
		fromStatus: PersonalizationStatus | null = null,
		toStatus: PersonalizationStatus | null = null,
	): AuditRecord {
		const detailsJson = details === null ? null : JSON.stringify(details);
		if (detailsJson !== null && detailsJson.length > MAX_AUDIT_DETAILS_LENGTH) {
			throw new Error(`audit details exceed ${MAX_AUDIT_DETAILS_LENGTH} characters.`);
		}
		const row = this.#db
			.query(`INSERT INTO personalization_audit(
				project_id, candidate_id, event, actor, reason, details_json, from_status, to_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
			.get(projectId, candidateId, event, actor, reason, detailsJson, fromStatus, toStatus) as AuditRow | null;
		if (!row) throw new Error("Failed to record personalization audit event.");
		return decodeAudit(row);
	}
}
