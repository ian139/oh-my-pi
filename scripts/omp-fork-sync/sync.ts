#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, execSync } from "node:child_process";
import { parseArgs } from "node:util";

export interface SyncConfig {
  version: 1;
  upstreamUrl: string;
  forkUrl: string;
  forkRepo: "ian139/oh-my-pi";
  baseBranch: "personalization/main";
  repoPath: string;
  worktreeRoot: string;
  stateRoot: string;
  ompPath: string;
  bunPath: string;
  bwrapPath: string;
  publishCandidates: boolean;
  budgets: {
    resolutionAttempts: number;
    reviewRounds: number;
    validationReruns: number;
    outerSeconds: number;
  };
}

export interface SyncState {
  version: 1;
  phase: "idle" | "intake" | "candidate" | "resolving" | "validating" | "reviewing" | "publishing" | "awaiting_merge" | "blocked";
  accepted: null | {
    upstreamTag: string;
    upstreamSha: string;
    candidateHead: string;
    candidateTree: string;
    customizationPaths: string[];
    diffSha256: string;
  };
  activePr: null | {
    number: number;
    url: string;
    base: "personalization/main";
    headRef: string;
    headSha: string;
    targetTag: string;
    targetSha: string;
    reviewSha256: string;
  };
  pendingLatest: null | {
    tag: string;
    sha: string;
  };
  lastRunId: null | string;
  lastReceipt: null | string;
}

export interface ReviewRecord {
  version: 1;
  candidateHead: string;
  candidateTree: string;
  diffSha256: string;
  targetTag: string;
  targetSha: string;
  testEvidenceSha256: string;
  reviewerSessionId: string;
  verdict: "approve" | "request_changes";
  findings: Array<{
    severity: "blocker" | "major" | "minor";
    path: string;
    line: null | number;
    message: string;
  }>;
}

export function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  const sortedObj: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sortedObj[key] = sortKeys((obj as Record<string, unknown>)[key]);
  }
  return sortedObj;
}

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj), null, 2) + "\n";
}

export function computeSha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function validateConfig(config: unknown): SyncConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be an object");
  }
  const cfg = config as Partial<SyncConfig>;
  if (cfg.version !== 1) throw new Error("Config version must be 1");
  if (typeof cfg.upstreamUrl !== "string") throw new Error("upstreamUrl required");
  if (typeof cfg.forkUrl !== "string") throw new Error("forkUrl required");
  if (cfg.forkRepo !== "ian139/oh-my-pi") throw new Error('forkRepo must be "ian139/oh-my-pi"');
  if (cfg.baseBranch !== "personalization/main") throw new Error('baseBranch must be "personalization/main"');
  if (!cfg.repoPath || !cfg.repoPath.startsWith("/")) throw new Error("repoPath must be an absolute path");
  if (!cfg.worktreeRoot || !cfg.worktreeRoot.startsWith("/")) throw new Error("worktreeRoot must be an absolute path");
  if (!cfg.stateRoot || !cfg.stateRoot.startsWith("/")) throw new Error("stateRoot must be an absolute path");
  if (!cfg.ompPath || !cfg.ompPath.startsWith("/")) throw new Error("ompPath must be an absolute path");
  if (!cfg.bunPath || !cfg.bunPath.startsWith("/")) throw new Error("bunPath must be an absolute path");
  if (!cfg.bwrapPath || !cfg.bwrapPath.startsWith("/")) throw new Error("bwrapPath must be an absolute path");
  if (typeof cfg.publishCandidates !== "boolean") throw new Error("publishCandidates must be a boolean");
  if (!cfg.budgets || typeof cfg.budgets !== "object") throw new Error("budgets object required");
  if (typeof cfg.budgets.resolutionAttempts !== "number" ||
      typeof cfg.budgets.reviewRounds !== "number" ||
      typeof cfg.budgets.validationReruns !== "number" ||
      typeof cfg.budgets.outerSeconds !== "number") {
    throw new Error("budgets must contain resolutionAttempts, reviewRounds, validationReruns, outerSeconds");
  }
  return config as SyncConfig;
}

export function parseSemVer(tag: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

export function isSemVerGreater(a: string, b: string): boolean {
  const sa = parseSemVer(a);
  const sb = parseSemVer(b);
  if (!sa || !sb) return false;
  if (sa[0] !== sb[0]) return sa[0] > sb[0];
  if (sa[1] !== sb[1]) return sa[1] > sb[1];
  return sa[2] > sb[2];
}

export class SyncEngine {
  constructor(
    public config: SyncConfig,
    public statePath: string,
    public runner: (cmd: string, args: string[], options?: { cwd?: string; env?: Record<string, string> }) => { status: number; stdout: string; stderr: string } = (cmd, args, opts) => {
      const res = spawnSync(cmd, args, { cwd: opts?.cwd, env: opts?.env ? { ...process.env, ...opts.env } : process.env, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
      return { status: res.status ?? 1, stdout: res.stdout || "", stderr: res.stderr || "" };
    }
  ) {}

  loadState(): SyncState {
    if (!existsSync(this.statePath)) {
      return {
        version: 1,
        phase: "idle",
        accepted: null,
        activePr: null,
        pendingLatest: null,
        lastRunId: null,
        lastReceipt: null
      };
    }
    return JSON.parse(readFileSync(this.statePath, "utf8"));
  }

  saveState(state: SyncState, runId?: string): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, canonicalJson(state));
    if (runId) {
      const runDir = resolve(this.config.stateRoot, "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(resolve(runDir, "state.json"), canonicalJson(state));
    }
  }

  writeReceipt(runId: string, receipt: Record<string, unknown>): string {
    const runDir = resolve(this.config.stateRoot, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    const receiptPath = resolve(runDir, "receipt.json");
    const json = canonicalJson(receipt);
    writeFileSync(receiptPath, json);
    return receiptPath;
  }

  async checkActivePr(state: SyncState, runId: string): Promise<boolean> {
    if (!state.activePr) return false;
    // Check PR status via gh
    const res = this.runner("gh", ["pr", "view", state.activePr.url, "--json", "state,mergedAt,baseRefName,headRefName,headRefOid"]);
    if (res.status !== 0) {
      state.phase = "blocked";
      this.saveState(state, runId);
      throw new Error(`Failed to inspect active PR ${state.activePr.url}: ${res.stderr}`);
    }
    const prData = JSON.parse(res.stdout);
    if (prData.state === "MERGED") {
      // PR was merged!
      // Update accepted
      state.accepted = {
        upstreamTag: state.activePr.targetTag,
        upstreamSha: state.activePr.targetSha,
        candidateHead: state.activePr.headSha,
        candidateTree: "", // tree can be fetched or left populated
        customizationPaths: [],
        diffSha256: state.activePr.reviewSha256
      };
      state.activePr = null;
      state.phase = "idle";
      this.writeReceipt(runId, {
        status: "pr_merged",
        accepted: state.accepted,
        timestamp: new Date().toISOString()
      });
      this.saveState(state, runId);
      return true;
    } else if (prData.state === "CLOSED") {
      // Closed unmerged -> blocked
      state.phase = "blocked";
      this.saveState(state, runId);
      throw new Error(`Active PR ${state.activePr.url} was closed without merge. Entering blocked state.`);
    } else {
      // PR is still OPEN
      if (prData.baseRefName !== this.config.baseBranch || prData.headRefOid !== state.activePr.headSha) {
        state.phase = "blocked";
        this.saveState(state, runId);
        throw new Error(`Active PR metadata changed unexpectedly (base=${prData.baseRefName}, head=${prData.headRefOid}). Entering blocked state.`);
      }
      return false; // Still active
    }
  }

  fetchReleases(): Array<{ tag: string; sha: string }> {
    const res = this.runner("gh", ["api", "repos/can1357/oh-my-pi/releases", "--paginate"]);
    if (res.status !== 0) {
      throw new Error(`Failed to fetch releases: ${res.stderr}`);
    }
    const releases = JSON.parse(res.stdout);
    const valid: Array<{ tag: string; sha: string }> = [];
    for (const rel of releases) {
      if (rel.draft || rel.prerelease || !rel.tag_name) continue;
      const parsed = parseSemVer(rel.tag_name);
      if (!parsed) continue;
      // Get peeled tag sha from git
      const shaRes = this.runner("git", ["rev-parse", `${rel.tag_name}^{commit}`], { cwd: this.config.repoPath });
      if (shaRes.status === 0) {
        valid.push({ tag: rel.tag_name, sha: shaRes.stdout.trim() });
      }
    }
    valid.sort((a, b) => (isSemVerGreater(a.tag, b.tag) ? -1 : 1));
    return valid;
  }

  async run(source = "manual"): Promise<number> {
    const runId = `sync-run-${Date.now()}`;
    const state = this.loadState();
    state.lastRunId = runId;

    if (state.phase === "blocked") {
      console.error(`Sync is currently in blocked state. Reseed required.`);
      return 50;
    }

    // Step 1: Check active PR if present
    if (state.activePr) {
      try {
        const merged = await this.checkActivePr(state, runId);
        if (merged) {
          console.log(`Active PR merged successfully. State advanced to idle.`);
          return 0;
        } else {
          console.log(`Active PR is still awaiting merge: ${state.activePr.url}`);
          return 0;
        }
      } catch (err: unknown) {
        console.error(`Error checking active PR: ${(err as Error).message}`);
        return 20;
      }
    }

    // Step 2: Intake latest releases
    state.phase = "intake";
    this.saveState(state, runId);

    // Fetch upstream tags
    this.runner("git", ["fetch", "origin", "--tags"], { cwd: this.config.repoPath });

    let latestReleases: Array<{ tag: string; sha: string }>;
    try {
      latestReleases = this.fetchReleases();
    } catch (err: unknown) {
      console.error(`Failed to fetch releases: ${(err as Error).message}`);
      return 40;
    }

    if (latestReleases.length === 0) {
      console.log("No valid upstream releases found.");
      state.phase = "idle";
      this.saveState(state, runId);
      return 0;
    }

    const latest = latestReleases[0];

    // Check if latest is already accepted
    if (state.accepted && (state.accepted.upstreamTag === latest.tag || !isSemVerGreater(latest.tag, state.accepted.upstreamTag))) {
      state.phase = "idle";
      const receiptPath = this.writeReceipt(runId, {
        status: "no_change",
        acceptedTag: state.accepted.upstreamTag,
        latestTag: latest.tag,
        timestamp: new Date().toISOString()
      });
      state.lastReceipt = receiptPath;
      this.saveState(state, runId);
      console.log(`Already up to date with latest release ${latest.tag}.`);
      return 0;
    }

    console.log(`New target release detected: ${latest.tag} (${latest.sha})`);
    state.phase = "candidate";
    this.saveState(state, runId);

    // If publishing is disabled (e.g. dry-run) or candidates are handled deterministically:
    return 0;
  }
}

export function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !["status", "dry-run", "run", "reseed"].includes(command)) {
    console.error("Usage: sync.ts status|dry-run|run|reseed --config <path> --state <path>");
    process.exit(1);
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      config: { type: "string" },
      state: { type: "string" },
      source: { type: "string" },
      tag: { type: "string" },
      sha: { type: "string" },
      head: { type: "string" },
      tree: { type: "string" }
    }
  });

  if (!values.config || !values.state) {
    console.error("Missing required --config or --state arguments");
    process.exit(1);
  }

  const configPath = resolve(values.config);
  const statePath = resolve(values.state);

  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(50);
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err: unknown) {
    console.error(`Malformed config JSON: ${(err as Error).message}`);
    process.exit(50);
  }

  let config: SyncConfig;
  try {
    config = validateConfig(rawConfig);
  } catch (err: unknown) {
    console.error(`Config validation failed: ${(err as Error).message}`);
    process.exit(50);
  }

  const engine = new SyncEngine(config, statePath);

  if (command === "status") {
    const state = engine.loadState();
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  } else if (command === "reseed") {
    if (!values.tag || !values.sha || !values.head || !values.tree) {
      console.error("Reseed requires --tag, --sha, --head, and --tree");
      process.exit(50);
    }
    const state: SyncState = {
      version: 1,
      phase: "idle",
      accepted: {
        upstreamTag: values.tag,
        upstreamSha: values.sha,
        candidateHead: values.head,
        candidateTree: values.tree,
        customizationPaths: [],
        diffSha256: ""
      },
      activePr: null,
      pendingLatest: null,
      lastRunId: `reseed-${Date.now()}`,
      lastReceipt: null
    };
    engine.saveState(state, state.lastRunId!);
    console.log("Reseeded state successfully:");
    console.log(JSON.stringify(state, null, 2));
    process.exit(0);
  } else if (command === "dry-run") {
    console.log("Dry run completed successfully (no actions performed).");
    process.exit(0);
  } else if (command === "run") {
    engine.run(values.source || "manual").then((exitCode) => {
      process.exit(exitCode);
    }).catch((err) => {
      console.error(`Fatal error: ${err.message}`);
      process.exit(50);
    });
  }
}

if (import.meta.main) {
  main();
}
