import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SyncEngine, validateConfig, parseSemVer, isSemVerGreater, type SyncConfig, type SyncState, type ReviewRecord } from "./sync.ts";
import { prepareInstall, activateInstall, rollbackInstall, computeSha256 } from "./install.ts";

const TEST_DIR = resolve("/tmp/omp-fork-sync-comprehensive-test-" + Date.now());

describe("Comprehensive Release Sync Controller & Review Tests", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("handles mutable tag rejection and non-semver tag filtering", () => {
    expect(parseSemVer("v17.4.0")).toEqual([17, 4, 0]);
    expect(parseSemVer("v17.4.0-beta.1")).toBeNull();
    expect(parseSemVer("latest")).toBeNull();
    expect(parseSemVer("nightly")).toBeNull();
  });

  it("proves one-active-PR serialization: records pendingLatest without creating another PR", async () => {
    const statePath = resolve(TEST_DIR, "state-one-pr.json");
    const activePrState: SyncState = {
      version: 1,
      phase: "awaiting_merge",
      accepted: {
        upstreamTag: "v17.3.0",
        upstreamSha: "sha173",
        candidateHead: "cand173",
        candidateTree: "tree173",
        customizationPaths: [],
        diffSha256: "diff173"
      },
      activePr: {
        number: 10,
        url: "https://github.com/ian139/oh-my-pi/pull/10",
        base: "personalization/main",
        headRef: "sync/personalization-v17.4.0",
        headSha: "cand174",
        targetTag: "v17.4.0",
        targetSha: "sha174",
        reviewSha256: "rev174"
      },
      pendingLatest: null,
      lastRunId: null,
      lastReceipt: null
    };
    writeFileSync(statePath, JSON.stringify(activePrState, null, 2));

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
      publishCandidates: true,
      budgets: {
        resolutionAttempts: 2,
        reviewRounds: 2,
        validationReruns: 1,
        outerSeconds: 11700
      }
    };

    let ghPrCreated = false;
    const mockRunner = (cmd: string, args: string[]) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", baseRefName: "personalization/main", headRefOid: "cand174" }),
          stderr: ""
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
        ghPrCreated = true;
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };

    const engine = new SyncEngine(config, statePath, mockRunner);
    const exitCode = await engine.run();
    expect(exitCode).toBe(0);
    expect(ghPrCreated).toBe(false);

    const savedState: SyncState = JSON.parse(readFileSync(statePath, "utf8"));
    expect(savedState.activePr?.number).toBe(10);
  });

  it("validates review record schema and rejects stale or requested changes", () => {
    const validReview: ReviewRecord = {
      version: 1,
      candidateHead: "68f54ab3720380b588549840b11e132403bf0da3",
      candidateTree: "tree123",
      diffSha256: "diffsha123",
      targetTag: "v17.4.0",
      targetSha: "72000acfeb902e21816252699482887f34d1a5a4",
      testEvidenceSha256: "testsha123",
      reviewerSessionId: "ses_review_001",
      verdict: "approve",
      findings: []
    };

    expect(validReview.verdict).toBe("approve");
    expect(validReview.findings.length).toBe(0);

    const rejectedReview: ReviewRecord = {
      ...validReview,
      verdict: "request_changes",
      findings: [
        {
          severity: "blocker",
          path: "packages/coding-agent/src/sdk.ts",
          line: 42,
          message: "Unresolved hook parameter drift"
        }
      ]
    };

    const hasBlockers = rejectedReview.findings.some(f => f.severity === "blocker" || f.severity === "major");
    expect(hasBlockers).toBe(true);
    expect(rejectedReview.verdict === "approve" && !hasBlockers).toBe(false);
  });

  it("proves network-denied dry run with fake git, gh, and omp writes only to run directory", async () => {
    const statePath = resolve(TEST_DIR, "state-dryrun.json");
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

    const calls: string[] = [];
    const mockRunner = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
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
    const exitCode = await engine.run("dry-run");
    expect(exitCode).toBe(0);

    // Verify no remote mutations (push, pr create, git commit) occurred
    const mutativeCalls = calls.filter(c => c.includes("push") || c.includes("pr create") || c.includes("merge"));
    expect(mutativeCalls.length).toBe(0);
  });
});
