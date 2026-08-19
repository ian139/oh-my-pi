import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDbBusyTimeoutMs, logger } from "@oh-my-pi/pi-utils";
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
} from "./types";
import { isLowRiskProposal, validatePersonalizationProposal } from "./validation";

const PERSONALIZATION_SCHEMA_VERSION = 1;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
	id INTEGER PRIMARY KEY,
	identity TEXT NOT NULL UNIQUE,
	root TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	last_seen_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;

CREATE TABLE IF NOT EXISTS trajectories (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_trajectories_project_created ON trajectories(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS candidates (
	id INTEGER PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK(kind IN ('instruction', 'tool_guidance', 'managed_skill', 'route')),
	scope TEXT NOT NULL CHECK(scope IN ('project', 'global')),
	title TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('pending', 'canary', 'active', 'rejected', 'rolled_back')),
	risk TEXT NOT NULL CHECK(risk IN ('low', 'high')),
	proposal_json TEXT NOT NULL,
	artifact_name TEXT,
	artifact_content TEXT,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;
CREATE INDEX IF NOT EXISTS idx_candidates_project_status ON candidates(project_id, status, id);

CREATE TABLE IF NOT EXISTS candidate_sources (
	id INTEGER PRIMARY KEY,
	candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
	source_type TEXT NOT NULL CHECK(source_type IN ('user', 'model', 'trajectory')),
	source_ref TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	UNIQUE(candidate_id, source_type, source_ref)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_candidate_sources_candidate ON candidate_sources(candidate_id);

CREATE TABLE IF NOT EXISTS outcomes (
	id INTEGER PRIMARY KEY,
	candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
	trajectory_id INTEGER NOT NULL REFERENCES trajectories(id) ON DELETE CASCADE,
	arm TEXT NOT NULL CHECK(arm IN ('control', 'treatment', 'active')),
	utility REAL NOT NULL CHECK(utility >= 0 AND utility <= 1),
	had_error INTEGER NOT NULL CHECK(had_error IN (0, 1)),
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH}),
	UNIQUE(candidate_id, trajectory_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_outcomes_candidate_arm ON outcomes(candidate_id, arm, created_at DESC);

CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY,
	project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
	candidate_id INTEGER REFERENCES candidates(id) ON DELETE CASCADE,
	event TEXT NOT NULL,
	from_status TEXT,
	to_status TEXT,
	details TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_candidate_created ON audit(candidate_id, created_at DESC);
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
	artifact_name: string | null;
	artifact_content: string | null;
	created_at: number;
	updated_at: number;
};
type CountRow = { count: number };
type ArmStatsRow = { arm: PersonalizationArm; samples: number; utility: number; error_rate: number };

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
		artifactName: row.artifact_name,
		artifactContent: row.artifact_content,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
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

export class PersonalizationStore {
	readonly #db: Database;
	readonly persistent: boolean;

	private constructor(db: Database, persistent: boolean) {
		this.#db = db;
		this.persistent = persistent;
	}

	static open(dbPath: string): PersonalizationStore {
		let db: Database | undefined;
		try {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
			db = new Database(dbPath);
			db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			PersonalizationStore.#initialize(db);
			return new PersonalizationStore(db, true);
		} catch (error) {
			try {
				db?.close();
			} catch {
				// Preserve the primary open error; the fallback is independent.
			}
			logger.warn("Personalization database unavailable; using in-memory storage", {
				dbPath,
				error: error instanceof Error ? error.message : String(error),
			});
			const memoryDb = new Database(":memory:");
			memoryDb.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
			PersonalizationStore.#initialize(memoryDb);
			return new PersonalizationStore(memoryDb, false);
		}
	}

	static #initialize(db: Database): void {
		db.run(SCHEMA_SQL);
		const version = db
			.query<{ details: string }, []>("SELECT details FROM audit WHERE event = 'schema_version' ORDER BY id DESC LIMIT 1")
			.get();
		let currentVersion = 0;
		if (version) {
			try {
				const parsed = JSON.parse(version.details) as { version?: unknown };
				if (typeof parsed.version === "number") currentVersion = parsed.version;
			} catch {
				currentVersion = 0;
			}
		}
		if (currentVersion > PERSONALIZATION_SCHEMA_VERSION) {
			throw new Error(`Personalization schema ${currentVersion} is newer than supported version ${PERSONALIZATION_SCHEMA_VERSION}.`);
		}
		if (currentVersion < PERSONALIZATION_SCHEMA_VERSION) {
			db.query("INSERT INTO audit(event, details) VALUES ('schema_version', ?)").run(
				JSON.stringify({ version: PERSONALIZATION_SCHEMA_VERSION }),
			);
		}
	}

	close(): void {
		this.#db.close();
	}

	ensureProject(identity: string, root: string): ProjectRecord {
		this.#db
			.query("INSERT INTO projects(identity, root) VALUES (?, ?) ON CONFLICT(identity) DO UPDATE SET root = excluded.root, last_seen_at = CAST(strftime('%s','now') AS INTEGER)")
			.run(identity, root);
		const row = this.#db.query<ProjectRow, [string]>("SELECT id, identity, root FROM projects WHERE identity = ?").get(identity);
		if (!row) throw new Error("Failed to persist personalization project identity.");
		return row;
	}

	prune(retentionDays: number): void {
		const days = Math.max(1, Math.floor(retentionDays));
		const cutoff = Math.floor(Date.now() / 1000) - days * 86_400;
		this.#db.transaction(() => {
			this.#db.query("DELETE FROM outcomes WHERE created_at < ?").run(cutoff);
			this.#db.query("DELETE FROM candidate_sources WHERE created_at < ? AND source_type = 'trajectory'").run(cutoff);
			this.#db.query("DELETE FROM trajectories WHERE created_at < ?").run(cutoff);
			this.#db.query("DELETE FROM audit WHERE created_at < ? AND event != 'schema_version'").run(cutoff);
		})();
	}

	recordTrajectory(input: TrajectoryInput): TrajectoryRecord {
		const result = this.#db
			.query(`INSERT INTO trajectories(
				project_id, prompt_preview, prompt_hash, model, duration_ms, session_id, session_ref,
				tool_count, error_count, retry_count, denied_count, utility
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
			.get(
				input.projectId,
				input.promptPreview,
				input.promptHash,
				input.model,
				Math.max(0, Math.floor(input.durationMs)),
				input.sessionId,
				input.sessionRef,
				Math.max(0, Math.floor(input.toolCount)),
				Math.max(0, Math.floor(input.errorCount)),
				Math.max(0, Math.floor(input.retryCount)),
				Math.max(0, Math.floor(input.deniedCount)),
				Math.min(1, Math.max(0, input.utility)),
			) as TrajectoryRow | null;
		if (!result) throw new Error("Failed to record personalization trajectory.");
		return decodeTrajectory(result);
	}

	getLatestTrajectory(projectId: number): TrajectoryRecord | null {
		const row = this.#db
			.query<TrajectoryRow, [number]>("SELECT * FROM trajectories WHERE project_id = ? ORDER BY id DESC LIMIT 1")
			.get(projectId);
		return row ? decodeTrajectory(row) : null;
	}

	listRecentTrajectoryIds(projectId: number, limit: number): number[] {
		return this.#db
			.query<{ id: number }, [number, number]>("SELECT id FROM trajectories WHERE project_id = ? ORDER BY id DESC LIMIT ?")
			.all(projectId, Math.max(0, Math.floor(limit)))
			.map(row => row.id);
	}

	setFeedback(trajectoryId: number, feedback: "good" | "bad", note: string | null): TrajectoryRecord {
		const utility = feedback === "good" ? 1 : 0;
		const row = this.#db.transaction(() => {
			const updated = this.#db
				.query("UPDATE trajectories SET feedback = ?, feedback_note = ?, utility = ? WHERE id = ? RETURNING *")
				.get(feedback, note, utility, trajectoryId) as TrajectoryRow | null;
			if (!updated) throw new Error(`Trajectory ${trajectoryId} was not found.`);
			this.#db.query("UPDATE outcomes SET utility = ? WHERE trajectory_id = ?").run(utility, trajectoryId);
			return updated;
		})();
		return decodeTrajectory(row);
	}

	createCandidate(
		projectId: number,
		proposal: PersonalizationProposal,
		source: CandidateSourceInput,
		evidenceTrajectoryIds: number[],
	): CandidateRecord {
		const risk = isLowRiskProposal(proposal) ? "low" : "high";
		const row = this.#db.transaction(() => {
			const inserted = this.#db
				.query(`INSERT INTO candidates(project_id, kind, scope, title, status, risk, proposal_json)
					VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING *`)
				.get(projectId, proposal.kind, proposal.scope, proposal.title, risk, JSON.stringify(proposal)) as CandidateRow | null;
			if (!inserted) throw new Error("Failed to create personalization candidate.");
			this.#insertSource(inserted.id, projectId, source);
			for (const trajectoryId of evidenceTrajectoryIds) {
				const exists = this.#db
					.query<{ id: number }, [number, number]>("SELECT id FROM trajectories WHERE id = ? AND project_id = ?")
					.get(trajectoryId, projectId);
				if (!exists) throw new Error(`Evidence trajectory ${trajectoryId} does not belong to this project.`);
				this.#insertSource(inserted.id, projectId, { type: "trajectory", ref: String(trajectoryId) });
			}
			return inserted;
		})();
		return decodeCandidate(row);
	}

	#insertSource(candidateId: number, projectId: number, source: CandidateSourceInput): boolean {
		const result = this.#db
			.query("INSERT OR IGNORE INTO candidate_sources(candidate_id, source_type, source_ref) VALUES (?, ?, ?)")
			.run(candidateId, source.type, source.ref);
		if (result.changes === 0) return false;
		this.#db
			.query("INSERT INTO audit(project_id, candidate_id, event, details) VALUES (?, ?, 'source_added', ?)")
			.run(projectId, candidateId, JSON.stringify(source));
		return true;
	}

	addTrajectorySource(candidateId: number, trajectoryId: number): boolean {
		const candidate = this.getCandidate(candidateId);
		if (!candidate) throw new Error(`Candidate ${candidateId} was not found.`);
		const trajectory = this.#db
			.query<{ project_id: number }, [number]>("SELECT project_id FROM trajectories WHERE id = ?")
			.get(trajectoryId);
		if (!trajectory || trajectory.project_id !== candidate.projectId) return false;
		return this.#insertSource(candidateId, candidate.projectId, { type: "trajectory", ref: String(trajectoryId) });
	}

	getCandidate(id: number): CandidateRecord | null {
		const row = this.#db.query<CandidateRow, [number]>("SELECT * FROM candidates WHERE id = ?").get(id);
		return row ? decodeCandidate(row) : null;
	}

	listCandidates(projectId: number, statuses?: PersonalizationStatus[]): CandidateRecord[] {
		const rows = statuses && statuses.length > 0
			? this.#db
					.query<CandidateRow, [number, ...PersonalizationStatus[]]>(
						`SELECT * FROM candidates WHERE (project_id = ? OR scope = 'global') AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`,
					)
					.all(projectId, ...statuses)
			: this.#db
					.query<CandidateRow, [number]>("SELECT * FROM candidates WHERE project_id = ? OR scope = 'global' ORDER BY id")
					.all(projectId);
		return rows.map(decodeCandidate);
	}

	countEvidence(candidateId: number): number {
		return (
			this.#db
				.query<CountRow, [number]>("SELECT COUNT(*) AS count FROM candidate_sources WHERE candidate_id = ? AND source_type = 'trajectory'")
				.get(candidateId)?.count ?? 0
		);
	}

	transition(id: number, to: PersonalizationStatus, reason: string): CandidateRecord {
		return this.#db.transaction(() => {
			const current = this.getCandidate(id);
			if (!current) throw new Error(`Candidate ${id} was not found.`);
			assertTransition(current.status, to);
			const row = this.#db
				.query("UPDATE candidates SET status = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ? RETURNING *")
				.get(to, id) as CandidateRow | null;
			if (!row) throw new Error(`Candidate ${id} disappeared during transition.`);
			this.#db
				.query("INSERT INTO audit(project_id, candidate_id, event, from_status, to_status, details) VALUES (?, ?, 'transition', ?, ?, ?)")
				.run(current.projectId, id, current.status, to, JSON.stringify({ reason }));
			return decodeCandidate(row);
		})();
	}

	setArtifact(id: number, name: string, content: string): void {
		const result = this.#db
			.query("UPDATE candidates SET artifact_name = ?, artifact_content = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?")
			.run(name, content, id);
		if (result.changes !== 1) throw new Error(`Candidate ${id} was not found.`);
	}

	recordOutcome(input: OutcomeInput): void {
		this.#db
			.query(`INSERT INTO outcomes(candidate_id, trajectory_id, arm, utility, had_error)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(candidate_id, trajectory_id) DO UPDATE SET arm = excluded.arm, utility = excluded.utility, had_error = excluded.had_error`)
			.run(input.candidateId, input.trajectoryId, input.arm, Math.min(1, Math.max(0, input.utility)), input.hadError ? 1 : 0);
	}

	seedControlBaseline(candidateId: number, projectId: number, limit: number): void {
		const rows = this.#db
			.query<{ id: number; utility: number; error_count: number }, [number, number]>(
				"SELECT id, utility, error_count FROM trajectories WHERE project_id = ? ORDER BY id DESC LIMIT ?",
			)
			.all(projectId, Math.max(1, Math.floor(limit)));
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
		if (candidate.status === "pending") {
			if (candidate.risk !== "low" || !settings.autoPromoteLowRisk) return null;
			if (this.countEvidence(candidateId) < settings.minEvidence) return null;
			this.transition(candidateId, "canary", "minimum evidence reached");
			return { candidateId, from: "pending", to: "canary", reason: "minimum evidence reached" };
		}

		const stats = this.#db
			.query<ArmStatsRow, [number]>(`SELECT arm, COUNT(*) AS samples, AVG(utility) AS utility, AVG(had_error) AS error_rate
				FROM outcomes WHERE candidate_id = ? GROUP BY arm`)
			.all(candidateId);
		const byArm = new Map(stats.map(row => [row.arm, row]));
		const control = byArm.get("control");
		if (!control || control.samples < settings.minEvaluationSamples) return null;

		if (candidate.status === "canary") {
			const treatment = byArm.get("treatment");
			if (!treatment || treatment.samples < settings.minEvaluationSamples) return null;
			const margin = treatment.utility - control.utility;
			if (margin < settings.promotionMargin || treatment.error_rate > control.error_rate) return null;
			this.transition(candidateId, "active", "canary utility margin met without error regression");
			return {
				candidateId,
				from: "canary",
				to: "active",
				reason: "canary utility margin met without error regression",
			};
		}

		if (candidate.status === "active") {
			const active = byArm.get("active");
			if (!active || active.samples < settings.minEvaluationSamples) return null;
			if (active.error_rate - control.error_rate < settings.regressionThreshold) return null;
			this.transition(candidateId, "rolled_back", "active error-rate regression threshold exceeded");
			return {
				candidateId,
				from: "active",
				to: "rolled_back",
				reason: "active error-rate regression threshold exceeded",
			};
		}
		return null;
	}
}
