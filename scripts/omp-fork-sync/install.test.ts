import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { prepareInstall, activateInstall, rollbackInstall, computeSha256 } from "./install.ts";

const TEST_DIR = resolve("/tmp/omp-install-test-" + Date.now());

describe("install.ts test suite", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("fails prepare on target identity drift", () => {
    const sourceBin = resolve(TEST_DIR, "omp-source");
    const targetBin = resolve(TEST_DIR, "omp-target");
    const journalFile = resolve(TEST_DIR, "install-journal.json");

    writeFileSync(sourceBin, "NEW_OMP_BINARY_CONTENT");
    writeFileSync(targetBin, "STOCK_17_4_0_CONTENT");

    const targetStat = statSync(targetBin);
    const targetSha = computeSha256(targetBin);

    // Provide mismatched expected target sha256
    expect(() => {
      prepareInstall({
        source: sourceBin,
        target: targetBin,
        journal: journalFile,
        sourceHead: "head123",
        expectedTargetSha256: "0000000000000000000000000000000000000000000000000000000000000000",
        expectedTargetDev: targetStat.dev,
        expectedTargetIno: targetStat.ino,
        expectedTargetMode: targetStat.mode,
        expectedTargetUid: targetStat.uid
      });
    }).toThrow(/Target sha256 mismatch/);
  });

  it("handles interrupted recovery after prepare", () => {
    const sourceBin = resolve(TEST_DIR, "omp-source");
    const targetBin = resolve(TEST_DIR, "omp-target");
    const journalFile = resolve(TEST_DIR, "install-journal.json");

    writeFileSync(sourceBin, "NEW_OMP_BINARY_CONTENT");
    writeFileSync(targetBin, "STOCK_17_4_0_CONTENT");

    const targetStat = statSync(targetBin);
    const targetSha = computeSha256(targetBin);
    const sourceSha = computeSha256(sourceBin);

    const journal = prepareInstall({
      source: sourceBin,
      target: targetBin,
      journal: journalFile,
      sourceHead: "head123",
      expectedTargetSha256: targetSha,
      expectedTargetDev: targetStat.dev,
      expectedTargetIno: targetStat.ino,
      expectedTargetMode: targetStat.mode,
      expectedTargetUid: targetStat.uid
    });

    expect(journal.phase).toBe("prepared");
    // Recovery via rollback should be clean
    const rolledBack = rollbackInstall(journalFile);
    expect(rolledBack.phase).toBe("rolled_back");
    expect(computeSha256(targetBin)).toBe(targetSha);
  });
});
