#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

export interface InstallJournal {
  version: 1;
  phase: "prepared" | "active" | "verified" | "rolled_back";
  sourceHead: string;
  sourceSha256: string;
  targetPath: string;
  expectedTarget: {
    sha256: string;
    dev: number;
    ino: number;
    mode: number;
    uid: number;
  };
  stage: {
    path: string;
    sha256: string;
    dev: number;
    ino: number;
  };
  backup: {
    path: string;
    sha256: string;
    dev: number;
    ino: number;
  };
  observedActiveSha256: string | null;
}

export function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function prepareInstall(options: {
  source: string;
  target: string;
  journal: string;
  sourceHead?: string;
  expectedTargetSha256: string;
  expectedTargetDev: number;
  expectedTargetIno: number;
  expectedTargetMode: number;
  expectedTargetUid: number;
}): InstallJournal {
  const sourcePath = resolve(options.source);
  const targetPath = resolve(options.target);
  const journalPath = resolve(options.journal);

  if (!existsSync(sourcePath)) {
    throw new Error(`Source binary does not exist: ${sourcePath}`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Target binary does not exist: ${targetPath}`);
  }

  const targetStat = statSync(targetPath);
  const targetSha256 = computeSha256(targetPath);

  // Validate exact expected target identity
  if (targetSha256 !== options.expectedTargetSha256) {
    throw new Error(`Target sha256 mismatch: expected ${options.expectedTargetSha256}, got ${targetSha256}`);
  }
  if (targetStat.dev !== options.expectedTargetDev) {
    throw new Error(`Target dev mismatch: expected ${options.expectedTargetDev}, got ${targetStat.dev}`);
  }
  if (targetStat.ino !== options.expectedTargetIno) {
    throw new Error(`Target ino mismatch: expected ${options.expectedTargetIno}, got ${targetStat.ino}`);
  }
  if (targetStat.uid !== options.expectedTargetUid) {
    throw new Error(`Target uid mismatch: expected ${options.expectedTargetUid}, got ${targetStat.uid}`);
  }

  const sourceSha256 = computeSha256(sourcePath);
  const targetDir = dirname(targetPath);
  const hash12 = targetSha256.slice(0, 12);
  const backupPath = resolve(targetDir, `omp.stock-17.4.0.${hash12}.bak`);
  const stagePath = resolve(targetDir, `omp.stage.${sourceSha256.slice(0, 12)}.${Date.now()}`);

  if (existsSync(backupPath)) {
    // Check if backup matches target
    const existingBackupSha = computeSha256(backupPath);
    if (existingBackupSha !== targetSha256) {
      throw new Error(`Existing backup hash mismatch at ${backupPath}`);
    }
  } else {
    copyFileSync(targetPath, backupPath);
  }

  const backupStat = statSync(backupPath);
  const backupSha256 = computeSha256(backupPath);

  // Create stage file in same directory
  copyFileSync(sourcePath, stagePath);
  const stageStat = statSync(stagePath);
  const stageSha256 = computeSha256(stagePath);

  if (stageSha256 !== sourceSha256) {
    throw new Error(`Stage file hash mismatch after copy: ${stageSha256} vs ${sourceSha256}`);
  }

  const journal: InstallJournal = {
    version: 1,
    phase: "prepared",
    sourceHead: options.sourceHead || "unknown",
    sourceSha256,
    targetPath,
    expectedTarget: {
      sha256: options.expectedTargetSha256,
      dev: options.expectedTargetDev,
      ino: options.expectedTargetIno,
      mode: options.expectedTargetMode,
      uid: options.expectedTargetUid
    },
    stage: {
      path: stagePath,
      sha256: stageSha256,
      dev: stageStat.dev,
      ino: stageStat.ino
    },
    backup: {
      path: backupPath,
      sha256: backupSha256,
      dev: backupStat.dev,
      ino: backupStat.ino
    },
    observedActiveSha256: null
  };

  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
  return journal;
}

export function activateInstall(journalPath: string): InstallJournal {
  const resolvedJournalPath = resolve(journalPath);
  if (!existsSync(resolvedJournalPath)) {
    throw new Error(`Journal does not exist: ${resolvedJournalPath}`);
  }
  const journal: InstallJournal = JSON.parse(readFileSync(resolvedJournalPath, "utf8"));
  if (journal.version !== 1) {
    throw new Error(`Invalid journal version: ${journal.version}`);
  }

  if (journal.phase === "active" || journal.phase === "verified") {
    // Already active, check target sha
    const curSha = computeSha256(journal.targetPath);
    if (curSha === journal.stage.sha256) {
      journal.observedActiveSha256 = curSha;
      writeFileSync(resolvedJournalPath, JSON.stringify(journal, null, 2) + "\n");
      return journal;
    }
  }

  if (!existsSync(journal.stage.path)) {
    throw new Error(`Stage file not found: ${journal.stage.path}`);
  }
  const stageSha = computeSha256(journal.stage.path);
  if (stageSha !== journal.stage.sha256) {
    throw new Error(`Stage file hash changed: expected ${journal.stage.sha256}, got ${stageSha}`);
  }

  // Atomically replace target by copy or rename
  copyFileSync(journal.stage.path, journal.targetPath);
  const activeSha = computeSha256(journal.targetPath);
  if (activeSha !== journal.stage.sha256) {
    throw new Error(`Failed to activate: target hash ${activeSha} does not match stage ${journal.stage.sha256}`);
  }

  journal.phase = "active";
  journal.observedActiveSha256 = activeSha;
  writeFileSync(resolvedJournalPath, JSON.stringify(journal, null, 2) + "\n");
  return journal;
}

export function rollbackInstall(journalPath: string): InstallJournal {
  const resolvedJournalPath = resolve(journalPath);
  if (!existsSync(resolvedJournalPath)) {
    throw new Error(`Journal does not exist: ${resolvedJournalPath}`);
  }
  const journal: InstallJournal = JSON.parse(readFileSync(resolvedJournalPath, "utf8"));
  if (journal.version !== 1) {
    throw new Error(`Invalid journal version: ${journal.version}`);
  }

  if (!existsSync(journal.backup.path)) {
    throw new Error(`Backup file not found: ${journal.backup.path}`);
  }
  const backupSha = computeSha256(journal.backup.path);
  if (backupSha !== journal.backup.sha256) {
    throw new Error(`Backup file corrupted: expected ${journal.backup.sha256}, got ${backupSha}`);
  }

  // Restore backup to target
  copyFileSync(journal.backup.path, journal.targetPath);
  const activeSha = computeSha256(journal.targetPath);
  if (activeSha !== journal.backup.sha256) {
    throw new Error(`Failed to rollback: target hash ${activeSha} does not match backup ${journal.backup.sha256}`);
  }

  // Cleanup stage if exists
  if (existsSync(journal.stage.path)) {
    try {
      unlinkSync(journal.stage.path);
    } catch {}
  }

  journal.phase = "rolled_back";
  journal.observedActiveSha256 = activeSha;
  writeFileSync(resolvedJournalPath, JSON.stringify(journal, null, 2) + "\n");
  return journal;
}

export function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !["prepare", "activate", "rollback"].includes(command)) {
    console.error("Usage: install.ts prepare|activate|rollback [options]");
    process.exit(1);
  }

  if (command === "prepare") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        source: { type: "string" },
        target: { type: "string" },
        journal: { type: "string" },
        "source-head": { type: "string" },
        "expected-target-sha256": { type: "string" },
        "expected-target-dev": { type: "string" },
        "expected-target-ino": { type: "string" },
        "expected-target-mode": { type: "string" },
        "expected-target-uid": { type: "string" }
      }
    });

    if (!values.source || !values.target || !values.journal || !values["expected-target-sha256"] ||
        values["expected-target-dev"] === undefined || values["expected-target-ino"] === undefined ||
        values["expected-target-mode"] === undefined || values["expected-target-uid"] === undefined) {
      console.error("Missing required arguments for prepare");
      process.exit(1);
    }

    try {
      const journal = prepareInstall({
        source: values.source,
        target: values.target,
        journal: values.journal,
        sourceHead: values["source-head"],
        expectedTargetSha256: values["expected-target-sha256"],
        expectedTargetDev: Number(values["expected-target-dev"]),
        expectedTargetIno: Number(values["expected-target-ino"]),
        expectedTargetMode: Number(values["expected-target-mode"]),
        expectedTargetUid: Number(values["expected-target-uid"])
      });
      console.log(JSON.stringify(journal, null, 2));
    } catch (err: any) {
      console.error(`Prepare failed: ${err.message}`);
      process.exit(1);
    }
  } else if (command === "activate") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        journal: { type: "string" }
      }
    });
    if (!values.journal) {
      console.error("Missing --journal argument");
      process.exit(1);
    }
    try {
      const journal = activateInstall(values.journal);
      console.log(JSON.stringify(journal, null, 2));
    } catch (err: any) {
      console.error(`Activate failed: ${err.message}`);
      process.exit(1);
    }
  } else if (command === "rollback") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        journal: { type: "string" }
      }
    });
    if (!values.journal) {
      console.error("Missing --journal argument");
      process.exit(1);
    }
    try {
      const journal = rollbackInstall(values.journal);
      console.log(JSON.stringify(journal, null, 2));
    } catch (err: any) {
      console.error(`Rollback failed: ${err.message}`);
      process.exit(1);
    }
  }
}

if (import.meta.main) {
  main();
}
