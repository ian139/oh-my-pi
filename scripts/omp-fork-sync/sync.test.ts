import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SyncEngine, validateConfig, parseSemVer, isSemVerGreater, type SyncConfig, type SyncState } from "./sync.ts";
import { prepareInstall, activateInstall, rollbackInstall, computeSha256 } from "./install.ts";

const TEST_DIR = resolve("/tmp/omp-fork-sync-test-" + Date.now());

describe("omp-fork-sync test suite", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("validates SemVer parsing and comparisons", () => {
    expect(parseSemVer("v17.4.0")).toEqual([17, 4, 0]);
    expect(parseSemVer("17.3.1")).toEqual([17, 3, 1]);
    expect(parseSemVer("invalid-tag")).toBeNull();

    expect(isSemVerGreater("v17.4.0", "v17.3.9")).toBe(true);
    expect(isSemVerGreater("v17.4.0", "v17.4.0")).toBe(false);
    expect(isSemVerGreater("v17.3.0", "v17.4.0")).toBe(false);
  });

  it("validates configuration schemas", () => {
    const validConfig: SyncConfig = {
      version: 1,
      upstreamUrl: "https://github.com/can1357/oh-my-pi.git",
      forkUrl: "https://github.com/ian139/oh-my-pi.git",
      forkRepo: "ian139/oh-my-pi",
      baseBranch: "personalization/main",
      repoPath: "/path/to/repo",
      worktreeRoot: "/path/to/worktrees",
      stateRoot: "/path/to/state",
      ompPath: "/path/to/omp",
      bunPath: "/path/to/bun",
      bwrapPath: "/path/to/bwrap",
      publishCandidates: false,
      budgets: {
        resolutionAttempts: 2,
        reviewRounds: 2,
        validationReruns: 1,
        outerSeconds: 11700
      }
    };

    expect(validateConfig(validConfig)).toEqual(validConfig);

    // Rejects relative paths
    expect(() => validateConfig({ ...validConfig, repoPath: "relative/path" })).toThrow();
    // Rejects wrong forkRepo
    expect(() => validateConfig({ ...validConfig, forkRepo: "other/repo" as any })).toThrow();
    // Rejects missing budgets
    expect(() => validateConfig({ ...validConfig, budgets: undefined as any })).toThrow();
  });

  it("handles idle state when latest release is already accepted", async () => {
    const statePath = resolve(TEST_DIR, "state.json");
    const initialState: SyncState = {
      version: 1,
      phase: "idle",
      accepted: {
        upstreamTag: "v17.4.0",
        upstreamSha: "72000acfeb902e21816252699482887f34d1a5a4",
        candidateHead: "68f54ab3720380b588549840b11e132403bf0da3",
        candidateTree: "abcdef",
        customizationPaths: [],
        diffSha256: "hash"
      },
      activePr: null,
      pendingLatest: null,
      lastRunId: null,
      lastReceipt: null
    };
    writeFileSync(statePath, JSON.stringify(initialState, null, 2));

    const config: SyncConfig = {
      version: 1,
      upstreamUrl: "https://github.com/can1357/oh-my-pi.git",
      forkUrl: "https://github.com/ian139/oh-my-pi.git",
      forkRepo: "ian139/oh-my-pi",
      baseBranch: "personalization/main",
      repoPath: "/tmp/repo",
      worktreeRoot: "/tmp/wt",
      stateRoot: TEST_DIR,
      ompPath: "/tmp/omp",
      bunPath: "/tmp/bun",
      bwrapPath: "/tmp/bwrap",
      publishCandidates: false,
      budgets: {
        resolutionAttempts: 2,
        reviewRounds: 2,
        validationReruns: 1,
        outerSeconds: 11700
      }
    };

    const mockRunner = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "api") {
        return {
          status: 0,
          stdout: JSON.stringify([{ tag_name: "v17.4.0", draft: false, prerelease: false }]),
          stderr: ""
        };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { status: 0, stdout: "72000acfeb902e21816252699482887f34d1a5a4\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const engine = new SyncEngine(config, statePath, mockRunner);
    const exitCode = await engine.run();
    expect(exitCode).toBe(0);

    const savedState: SyncState = JSON.parse(readFileSync(statePath, "utf8"));
    expect(savedState.phase).toBe("idle");
    expect(savedState.lastReceipt).toBeTruthy();
  });

  it("handles active PR check: still open vs merged vs closed-unmerged", async () => {
    const statePath = resolve(TEST_DIR, "state-pr.json");
    const activePrState: SyncState = {
      version: 1,
      phase: "awaiting_merge",
      accepted: null,
      activePr: {
        number: 42,
        url: "https://github.com/ian139/oh-my-pi/pull/42",
        base: "personalization/main",
        headRef: "sync/personalization-v17.4.1",
        headSha: "candidate123",
        targetTag: "v17.4.1",
        targetSha: "target123",
        reviewSha256: "revhash"
      },
      pendingLatest: null,
      lastRunId: null,
      lastReceipt: null
    };

    const config: SyncConfig = {
      version: 1,
      upstreamUrl: "https://github.com/can1357/oh-my-pi.git",
      forkUrl: "https://github.com/ian139/oh-my-pi.git",
      forkRepo: "ian139/oh-my-pi",
      baseBranch: "personalization/main",
      repoPath: "/tmp/repo",
      worktreeRoot: "/tmp/wt",
      stateRoot: TEST_DIR,
      ompPath: "/tmp/omp",
      bunPath: "/tmp/bun",
      bwrapPath: "/tmp/bwrap",
      publishCandidates: false,
      budgets: {
        resolutionAttempts: 2,
        reviewRounds: 2,
        validationReruns: 1,
        outerSeconds: 11700
      }
    };

    // Case 1: Still open
    writeFileSync(statePath, JSON.stringify(activePrState, null, 2));
    let mockRunner = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", baseRefName: "personalization/main", headRefOid: "candidate123" }),
          stderr: ""
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    let engine = new SyncEngine(config, statePath, mockRunner);
    let exitCode = await engine.run();
    expect(exitCode).toBe(0);
    let st: SyncState = JSON.parse(readFileSync(statePath, "utf8"));
    expect(st.activePr).not.toBeNull();

    // Case 2: Merged
    mockRunner = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "MERGED", baseRefName: "personalization/main", headRefOid: "candidate123" }),
          stderr: ""
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    engine = new SyncEngine(config, statePath, mockRunner);
    exitCode = await engine.run();
    expect(exitCode).toBe(0);
    st = JSON.parse(readFileSync(statePath, "utf8"));
    expect(st.phase).toBe("idle");
    expect(st.activePr).toBeNull();
    expect(st.accepted?.upstreamTag).toBe("v17.4.1");

    // Case 3: Closed without merge -> blocked
    writeFileSync(statePath, JSON.stringify(activePrState, null, 2));
    mockRunner = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "CLOSED", baseRefName: "personalization/main", headRefOid: "candidate123" }),
          stderr: ""
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    engine = new SyncEngine(config, statePath, mockRunner);
    exitCode = await engine.run();
    expect(exitCode).toBe(20);
    st = JSON.parse(readFileSync(statePath, "utf8"));
    expect(st.phase).toBe("blocked");
  });

  it("tests atomic installer prepare, activate, and rollback lifecycle", () => {
    const sourceBin = resolve(TEST_DIR, "omp-source");
    const targetBin = resolve(TEST_DIR, "omp-target");
    const journalFile = resolve(TEST_DIR, "install-journal.json");

    writeFileSync(sourceBin, "NEW_OMP_BINARY_CONTENT");
    writeFileSync(targetBin, "STOCK_17_4_0_CONTENT");

    const targetStat = statSync(targetBin);
    const targetSha = computeSha256(targetBin);
    const sourceSha = computeSha256(sourceBin);

    // 1. Prepare
    const journal = prepareInstall({
      source: sourceBin,
      target: targetBin,
      journal: journalFile,
      sourceHead: "candidate-sha-123",
      expectedTargetSha256: targetSha,
      expectedTargetDev: targetStat.dev,
      expectedTargetIno: targetStat.ino,
      expectedTargetMode: targetStat.mode,
      expectedTargetUid: targetStat.uid
    });

    expect(journal.phase).toBe("prepared");
    expect(existsSync(journal.backup.path)).toBe(true);
    expect(computeSha256(journal.backup.path)).toBe(targetSha);
    expect(existsSync(journal.stage.path)).toBe(true);
    expect(computeSha256(journal.stage.path)).toBe(sourceSha);
    // Target is still stock
    expect(computeSha256(targetBin)).toBe(targetSha);

    // 2. Activate
    const activeJournal = activateInstall(journalFile);
    expect(activeJournal.phase).toBe("active");
    expect(computeSha256(targetBin)).toBe(sourceSha);

    // 3. Rollback
    const rolledBackJournal = rollbackInstall(journalFile);
    expect(rolledBackJournal.phase).toBe("rolled_back");
    expect(computeSha256(targetBin)).toBe(targetSha);
  });
});
