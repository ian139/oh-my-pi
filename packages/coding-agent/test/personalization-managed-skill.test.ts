import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createPersonalizationManagedSkill,
	deleteManagedSkillIfExact,
	getManagedSkillsDir,
	recoverPersonalizationManagedSkill,
} from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

describe("personalization managed skills", () => {
	let agentDir: string;
	let originalAgentDir: string;
	let tempDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-personalization-skill-"));
		agentDir = path.join(tempDir, "agent");
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempDir);
	});

	const createSkill = () =>
		createPersonalizationManagedSkill({
			agentDir,
			projectPrefix: "My Project!",
			candidateId: 42,
			suffix: "Debug Helper",
			description: "Use for focused debugging.",
			body: "# Debug Helper\n\nInspect evidence before changing code.",
		});

	it("derives a bounded project/candidate/suffix name and returns exact serializable identity", async () => {
		const artifact = await createSkill();

		expect(artifact.name).toBe("personalization-my-project-42-debug-helper");
		expect(artifact.path).toBe(await fs.realpath(artifact.path));
		expect(artifact.path).toBe(path.join(await fs.realpath(getManagedSkillsDir(agentDir)), artifact.name, "SKILL.md"));
		expect(artifact.contentSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(artifact.size).toBeGreaterThan(0);
		expect(artifact.dev === null || Number.isSafeInteger(artifact.dev)).toBe(true);
		expect(artifact.ino === null || Number.isSafeInteger(artifact.ino)).toBe(true);
		expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
	});

	it("is create-only and preserves the first skill on collision", async () => {
		const first = await createSkill();
		const original = await Bun.file(first.path).text();

		await expect(createSkill()).rejects.toThrow(/already exists/);
		expect(await Bun.file(first.path).text()).toBe(original);
	});

	it("recovers both pre-artifact and persisted-artifact approval crash windows", async () => {
		const created = await createSkill();
		const input = {
			agentDir,
			projectPrefix: "My Project!",
			candidateId: 42,
			suffix: "Debug Helper",
			description: "Use for focused debugging.",
			body: "# Debug Helper\n\nInspect evidence before changing code.",
		};

		expect(await recoverPersonalizationManagedSkill(input)).toEqual(created);
		expect(await recoverPersonalizationManagedSkill(input, created)).toEqual(created);
		await fs.rm(path.dirname(created.path), { recursive: true });
		await expect(recoverPersonalizationManagedSkill(input, created)).rejects.toThrow();
		expect(await Bun.file(created.path).exists()).toBe(false);
	});

	it("deletes only the exact created skill", async () => {
		const artifact = await createSkill();

		await deleteManagedSkillIfExact({ ...artifact, agentDir });

		expect(await Bun.file(artifact.path).exists()).toBe(false);
		expect(await fs.lstat(path.dirname(artifact.path)).catch(() => null)).toBeNull();
	});

	it("fails closed when content is changed without changing its size", async () => {
		const artifact = await createSkill();
		const original = await Bun.file(artifact.path).text();
		const tampered = `X${original.slice(1)}`;
		await Bun.write(artifact.path, tampered);

		await expect(deleteManagedSkillIfExact({ ...artifact, agentDir })).rejects.toThrow(/content hash/i);
		expect(await Bun.file(artifact.path).text()).toBe(tampered);
	});

	it("fails closed when the file identity changes even if content is identical", async () => {
		const artifact = await createSkill();
		const content = await Bun.file(artifact.path).arrayBuffer();
		await fs.unlink(artifact.path);
		await Bun.write(artifact.path, content);

		await expect(deleteManagedSkillIfExact({ ...artifact, agentDir })).rejects.toThrow(/identity/i);
		expect(await Bun.file(artifact.path).exists()).toBe(true);
	});

	it("fails closed when the persisted canonical path or managed root changes", async () => {
		const artifact = await createSkill();
		await expect(
			deleteManagedSkillIfExact({ ...artifact, path: path.join(tempDir, "other", "SKILL.md"), agentDir }),
		).rejects.toThrow(/canonical path/i);
		expect(await Bun.file(artifact.path).exists()).toBe(true);

		const managedRoot = getManagedSkillsDir(agentDir);
		const relocatedRoot = path.join(tempDir, "relocated-managed-skills");
		await fs.rename(managedRoot, relocatedRoot);
		await fs.symlink(relocatedRoot, managedRoot);

		await expect(deleteManagedSkillIfExact({ ...artifact, agentDir })).rejects.toThrow(/root is a symlink/i);
		expect(await Bun.file(path.join(relocatedRoot, artifact.name, "SKILL.md")).exists()).toBe(true);
	});

	it("fails closed for a symlinked file or skill directory", async () => {
		const fileArtifact = await createSkill();
		const outsideFile = path.join(tempDir, "outside.md");
		await Bun.write(outsideFile, "outside");
		await fs.unlink(fileArtifact.path);
		await fs.symlink(outsideFile, fileArtifact.path);

		await expect(deleteManagedSkillIfExact({ ...fileArtifact, agentDir })).rejects.toThrow(/symlink/i);
		expect(await Bun.file(outsideFile).text()).toBe("outside");

		await fs.unlink(fileArtifact.path);
		await fs.rmdir(path.dirname(fileArtifact.path));
		const outsideDir = path.join(tempDir, "outside-dir");
		await fs.mkdir(outsideDir);
		await Bun.write(path.join(outsideDir, "SKILL.md"), "outside directory");
		await fs.symlink(outsideDir, path.dirname(fileArtifact.path));

		await expect(deleteManagedSkillIfExact({ ...fileArtifact, agentDir })).rejects.toThrow(/symlink/i);
		expect(await Bun.file(path.join(outsideDir, "SKILL.md")).text()).toBe("outside directory");
	});

	it("fails closed when SKILL.md has another hard link", async () => {
		const artifact = await createSkill();
		const outside = path.join(tempDir, "outside-hard-link.md");
		await fs.link(artifact.path, outside);

		await expect(deleteManagedSkillIfExact({ ...artifact, agentDir })).rejects.toThrow(/hard links/i);
		expect(await Bun.file(artifact.path).exists()).toBe(true);
		expect(await Bun.file(outside).exists()).toBe(true);
	});
});
