import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { PersonalizationStore } from "@oh-my-pi/pi-coding-agent/personalization";
import type { PersonalizationProposal, TrajectoryInput } from "@oh-my-pi/pi-coding-agent/personalization";
import { TempDir } from "@oh-my-pi/pi-utils";

function trajectory(projectId: number, suffix: string, utility = 0.5): TrajectoryInput {
	return {
		projectId,
		promptPreview: `focused-test ${suffix}`,
		promptHash: `hash-${suffix}`,
		model: "openai/gpt-5.2",
		durationMs: 100,
		sessionId: `session-${suffix}`,
		sessionRef: null,
		toolCount: 1,
		errorCount: 0,
		retryCount: 0,
		deniedCount: 0,
		utility,
	};
}

function proposal(evidenceTrajectoryIds: number[]): PersonalizationProposal {
	return {
		kind: "instruction",
		scope: "project",
		title: "Prefer focused checks",
		trigger: { terms: ["focused-test"], match: "any" },
		content: "Run the focused behavioral check first.",
		evidenceTrajectoryIds,
	};
}

describe("PersonalizationStore", () => {
	let tempDir: TempDir;
	let dbPath: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@test-personalization-store-");
		dbPath = tempDir.join("agent.db");
	});

	afterEach(async () => {
		await tempDir.remove().catch(() => {});
	});

	test("creates and reopens only prefixed schema v1 tables", () => {
		const store = PersonalizationStore.open(dbPath);
		const project = store.ensureProject("project-a", "/project-a");
		store.recordTrajectory(trajectory(project.id, "one"));
		store.close();
		const reopened = PersonalizationStore.open(dbPath);
		expect(reopened.persistent).toBe(true);
		expect(reopened.getLatestTrajectory(project.id)?.sessionId).toBe("session-one");
		reopened.close();
		const db = new Database(dbPath, { readonly: true });
		const tables = db
			.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'personalization_%' ORDER BY name")
			.all()
			.map(row => row.name);
		expect(tables).toEqual([
			"personalization_audit",
			"personalization_candidate_sources",
			"personalization_candidates",
			"personalization_outcomes",
			"personalization_projects",
			"personalization_schema",
			"personalization_trajectories",
		]);
		db.close();
	});

	test("falls back without rewriting mismatched or corrupt files", async () => {
		const db = new Database(dbPath);
		db.run("CREATE TABLE personalization_schema(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL) STRICT");
		db.run("INSERT INTO personalization_schema VALUES (1, 2)");
		db.close();
		const before = await fs.readFile(dbPath);
		const fallback = PersonalizationStore.open(dbPath);
		expect(fallback.persistent).toBe(false);
		expect(fallback.fallbackReason).toContain("schema 2");
		fallback.close();
		expect(await fs.readFile(dbPath)).toEqual(before);
		const corruptPath = tempDir.join("corrupt.db");
		await fs.writeFile(corruptPath, "not sqlite");
		const corrupt = PersonalizationStore.open(corruptPath);
		expect(corrupt.persistent).toBe(false);
		corrupt.close();
		expect(await fs.readFile(corruptPath, "utf8")).toBe("not sqlite");
	});

	test("enforces same-project evidence transactionally and idempotent outcomes", () => {
		const store = PersonalizationStore.open(dbPath);
		const a = store.ensureProject("a", "/a");
		const b = store.ensureProject("b", "/b");
		const ta = store.recordTrajectory(trajectory(a.id, "a"));
		const tb = store.recordTrajectory(trajectory(b.id, "b"));
		expect(() => store.createCandidate(a.id, proposal([ta.id, tb.id]), { type: "user", ref: "command" })).toThrow(
			"does not belong to this project",
		);
		expect(store.listCandidates(a.id)).toEqual([]);
		const candidate = store.createCandidate(a.id, proposal([ta.id]), { type: "user", ref: "command" });
		store.recordOutcome({ candidateId: candidate.id, trajectoryId: ta.id, arm: "control", utility: 0.4, hadError: false });
		store.recordOutcome({ candidateId: candidate.id, trajectoryId: ta.id, arm: "control", utility: 0.7, hadError: true });
		expect(store.getOutcomeStats(candidate.id).get("control")).toEqual({ arm: "control", samples: 1, utility: 0.7, errorRate: 1 });
		store.close();
	});

	test("audits transitions, stores promotion baseline, and rolls back on utility regression", () => {
		const settings = {
			minEvidence: 2,
			minEvaluationSamples: 3,
			promotionMargin: 0.1,
			regressionThreshold: 0.15,
			autoPromoteLowRisk: true,
		};
		const store = PersonalizationStore.open(dbPath);
		const project = store.ensureProject("a", "/a");
		const rows = Array.from({ length: 11 }, (_, index) =>
			store.recordTrajectory(trajectory(project.id, String(index), index < 5 ? 0.5 : index < 8 ? 0.7 : 0.3)),
		);
		const candidate = store.createCandidate(project.id, proposal([rows[0].id, rows[1].id]), { type: "model", ref: "reflection" });
		expect(store.evaluateCandidate(candidate.id, settings)?.to).toBe("canary");
		for (const row of rows.slice(2, 5)) store.recordOutcome({ candidateId: candidate.id, trajectoryId: row.id, arm: "control", utility: 0.5, hadError: false });
		for (const row of rows.slice(5, 8)) store.recordOutcome({ candidateId: candidate.id, trajectoryId: row.id, arm: "treatment", utility: 0.7, hadError: false });
		expect(store.evaluateCandidate(candidate.id, settings)?.to).toBe("active");
		expect(store.getCandidate(candidate.id)).toMatchObject({ autoPromoted: true, promotionBaselineUtility: 0.5 });
		for (const row of rows.slice(8)) store.recordOutcome({ candidateId: candidate.id, trajectoryId: row.id, arm: "active", utility: 0.3, hadError: false });
		expect(store.evaluateCandidate(candidate.id, settings)?.to).toBe("rolled_back");
		const transitions = store.listAudit(candidate.id).filter(row => row.event === "transition");
		expect(transitions.map(row => [row.fromStatus, row.toStatus, row.actor])).toEqual([
			["pending", "canary", "system"],
			["canary", "active", "system"],
			["active", "rolled_back", "system"],
		]);
		store.close();
	});

	test("retention preserves candidate source and audit explanation", () => {
		let store = PersonalizationStore.open(dbPath);
		const project = store.ensureProject("a", "/a");
		const old = store.recordTrajectory(trajectory(project.id, "old"));
		const candidate = store.createCandidate(project.id, proposal([old.id]), { type: "user", ref: "command" });
		store.close();
		const db = new Database(dbPath);
		db.query("UPDATE personalization_trajectories SET created_at=1 WHERE id=?").run(old.id);
		db.close();
		store = PersonalizationStore.open(dbPath);
		expect(store.prune(30)).toBe(1);
		store.close();
		const inspect = new Database(dbPath, { readonly: true });
		expect(inspect.query<{ count: number }, [number]>("SELECT COUNT(*) count FROM personalization_candidate_sources WHERE candidate_id=?").get(candidate.id)?.count).toBe(2);
		expect(inspect.query<{ count: number }, [number]>("SELECT COUNT(*) count FROM personalization_audit WHERE candidate_id=?").get(candidate.id)?.count).toBeGreaterThan(0);
		inspect.close();
	});
});
