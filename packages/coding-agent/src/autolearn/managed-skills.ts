/**
 * Managed-skills primitives for the experimental auto-learn feature.
 *
 * Managed skills are auto-generated/enhanced `SKILL.md` files kept in an
 * isolated directory (`~/.omp/agent/managed-skills`) separate from
 * user-authored skills (`~/.omp/agent/skills`). They are discovered and
 * surfaced like normal skills, but every write here is confined to
 * `getManagedSkillsDir()` — auto-management can never touch authored skills.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** Provider id stamped on discovered managed skills (distinguishes them from authored). */
export const MANAGED_SKILLS_PROVIDER_ID = "omp-managed";

/** Hard cap on a managed SKILL.md body to keep generated skills bounded. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolve the isolated managed-skills directory (`~/.omp/agent/managed-skills`). */
export function getManagedSkillsDir(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "managed-skills");
}

/**
 * Validate + normalize a managed-skill name. Throws on anything outside the
 * strict allowlist so a bad name can never escape `getManagedSkillsDir()`
 * (blocks `..`, slashes, empty, and uppercase).
 */
export function sanitizeSkillName(raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!SKILL_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`,
		);
	}
	return name;
}

/**
 * Whether `name` is a safe managed-skill name (the exact post-sanitize shape).
 * Used to validate names read from disk at discovery time — a managed
 * `SKILL.md` whose `frontmatter.name` was not produced by `sanitizeSkillName`
 * (e.g. hand-placed) must not render unescaped into the system prompt.
 */
export function isValidManagedSkillName(name: string): boolean {
	return SKILL_NAME_PATTERN.test(name);
}

/**
 * Neutralize a machine-generated managed-skill description so it cannot break
 * out of the system prompt's `<skills>` listing. Managed descriptions are
 * generated from prior task content and persist across sessions, so this is a
 * trust boundary: strip control/format chars, angle brackets (`<system-directive>`
 * / `</skills>`), and Markdown fence delimiters (backticks, `~~~`), then collapse
 * to a single line. Applied on BOTH write and read so existing files are safe too.
 */
export function sanitizeManagedDescription(raw: string): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Serialize the minimal `name`/`description` frontmatter block via the repo's
 * YAML helper (round-trips through `parseFrontmatter`).
 */
export function toSkillFrontmatter(name: string, description: string): string {
	const frontmatter = YAML.stringify(
		{ name, description: sanitizeManagedDescription(description) },
		null,
		2,
	).trimEnd();
	return `---\n${frontmatter}\n---\n`;
}

export interface WriteManagedSkillInput {
	action: "create" | "update";
	name: string;
	description: string;
	body: string;
	agentDir?: string;
}

export interface ManagedSkillArtifactIdentity {
	name: string;
	path: string;
	contentSha256: string;
	size: number;
	dev: number | null;
	ino: number | null;
}

export interface CreatePersonalizationManagedSkillInput {
	projectPrefix: string;
	candidateId: number;
	suffix: string;
	description: string;
	body: string;
	agentDir?: string;
}

export interface DeleteManagedSkillIfExactInput extends ManagedSkillArtifactIdentity {
	agentDir?: string;
}

/**
 * Serialize mutations on the same skill path. Both tools are non-exclusive,
 * so a parallel tool batch in one turn can otherwise observe a file mid-delete.
 * This per-path promise chain runs same-skill mutations in submission order
 * while different managed roots and names still proceed in parallel.
 * In-process only; cross-process races are out of scope.
 */
const skillMutationChains = new Map<string, Promise<unknown>>();
function serializeSkillMutation<T>(key: string, op: () => Promise<T>): Promise<T> {
	const prev = skillMutationChains.get(key) ?? Promise.resolve();
	const run = prev.then(op, op);
	const guarded = run.catch(() => {});
	skillMutationChains.set(key, guarded);
	void guarded.finally(() => {
		if (skillMutationChains.get(key) === guarded) skillMutationChains.delete(key);
	});
	return run;
}

function getSkillMutationKey(managedRoot: string, name: string): string {
	return `${path.resolve(managedRoot)}\0${name}`;
}

function hasErrnoCode(error: unknown, code: string): boolean {
	if (!error || typeof error !== "object") return false;
	if ("code" in error && error.code === code) return true;
	return "cause" in error && hasErrnoCode(error.cause, code);
}

/**
 * Reject when the managed-skills root itself is a symlink. lstat on a child
 * follows intermediate components, so a symlinked root would let an otherwise
 * valid name write/delete outside the isolated directory (e.g. onto authored
 * skills). Checked before composing any child path.
 */
async function assertManagedRootSafe(agentDir?: string): Promise<void> {
	const rootStat = await fs.lstat(getManagedSkillsDir(agentDir)).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (rootStat?.isSymbolicLink()) {
		throw new Error("The managed-skills root is a symlink; refusing to operate outside the managed directory.");
	}
	if (rootStat !== null && !rootStat.isDirectory()) {
		throw new Error("The managed-skills root is not a directory; refusing to operate.");
	}
}

const UPDATE_FILE_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;

function assertManagedSkillFileSafeForUpdate(name: string, fileStat: Stats): void {
	if (!fileStat.isFile()) {
		throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing to overwrite it.`);
	}
	if (fileStat.nlink > 1) {
		throw new Error(
			`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing to overwrite a file that may be user-authored elsewhere.`,
		);
	}
}

async function openManagedSkillFileForUpdate(name: string, file: string) {
	try {
		return await fs.open(file, UPDATE_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		throw err;
	}
}

function buildManagedSkillContent(name: string, description: string, body: string): string {
	const safeDescription = sanitizeManagedDescription(description);
	const trimmedBody = body.trim();
	if (!safeDescription) {
		throw new Error(`Managed skill "${name}" needs a non-empty description.`);
	}
	if (!trimmedBody) {
		throw new Error(`Managed skill "${name}" needs a non-empty body.`);
	}
	const content = `${toSkillFrontmatter(name, safeDescription)}\n${trimmedBody}\n`;
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_MANAGED_SKILL_BYTES) {
		throw new Error(
			`Managed skill is ${bytes} bytes; the limit is ${MAX_MANAGED_SKILL_BYTES}. Trim the body or description.`,
		);
	}
	return content;
}

/** Create or update a managed `SKILL.md`. Returns the resolved file path. */
export async function writeManagedSkill(input: WriteManagedSkillInput): Promise<{ path: string }> {
	const name = sanitizeSkillName(input.name);
	const content = buildManagedSkillContent(name, input.description, input.body);
	const managedRoot = getManagedSkillsDir(input.agentDir);
	return serializeSkillMutation(getSkillMutationKey(managedRoot, name), async () => {
		await assertManagedRootSafe(input.agentDir);
		const dir = path.join(managedRoot, name);
		const file = path.join(dir, "SKILL.md");
		// Reject a symlinked skill directory: an intermediate symlink would let the
		// write escape the isolated managed root. lstat does not follow the final
		// component, so a symlinked `dir` is caught here.
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(
				`Managed skill "${name}" resolves through a symlink; refusing to write outside the managed directory.`,
			);
		}
		if (input.action === "create") {
			await fs.mkdir(dir, { recursive: true });
			// O_CREAT|O_EXCL ("wx"): atomic create that fails if the file already
			// exists (closing the check-then-write race) and refuses a symlinked SKILL.md.
			try {
				await fs.writeFile(file, content, { flag: "wx" });
			} catch (err) {
				if (hasErrnoCode(err, "EEXIST")) {
					throw new Error(`Managed skill "${name}" already exists. Use action "update" to change it.`, {
						cause: err,
					});
				}
				throw err;
			}
			return { path: file };
		}
		// update: the file must already exist, be a plain managed file, and must
		// not share an inode with a user-authored file via hard link. Open the
		// checked file handle before truncating so a path swap after lstat cannot
		// redirect the write into a symlink or newly hard-linked target.
		const fileStat = await fs.lstat(file).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (fileStat === null) {
			throw new Error(`Managed skill "${name}" does not exist. Use action "create" to add it.`);
		}
		if (fileStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing to overwrite it.`);
		}
		assertManagedSkillFileSafeForUpdate(name, fileStat);
		const handle = await openManagedSkillFileForUpdate(name, file);
		try {
			const openStat = await handle.stat();
			assertManagedSkillFileSafeForUpdate(name, openStat);
			await handle.truncate(0);
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		return { path: file };
	});
}

/** Delete a managed skill directory. Throws when it does not exist. */
export async function deleteManagedSkill(name: string): Promise<void> {
	const safe = sanitizeSkillName(name);
	const managedRoot = getManagedSkillsDir();
	await serializeSkillMutation(getSkillMutationKey(managedRoot, safe), async () => {
		await assertManagedRootSafe();
		const dir = path.join(managedRoot, safe);
		// Refuse to follow a symlinked skill directory (rm would delete the target).
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat?.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" is a symlink; refusing to delete outside the managed directory.`);
		}
		try {
			await fs.rm(dir, { recursive: true });
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(`Managed skill "${safe}" does not exist.`);
			}
			throw err;
		}
	});
}

const PERSONALIZATION_MANAGED_SKILL_PREFIX = "personalization";
const READ_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

function sanitizePersonalizationNamePart(raw: string, label: string): string {
	const sanitized = raw
		.trim()
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!sanitized) {
		throw new Error(`Personalization managed skill ${label} must contain a letter or digit.`);
	}
	return sanitized;
}

function truncateNamePart(value: string, maxLength: number): string {
	const truncated = value.slice(0, maxLength).replace(/-+$/g, "");
	return truncated || value.slice(0, 1);
}

/** Build the reserved, candidate-specific name used for a personalization-managed skill. */
export function getPersonalizationManagedSkillName(
	projectPrefix: string,
	candidateId: number,
	suffix: string,
): string {
	if (!Number.isSafeInteger(candidateId) || candidateId <= 0) {
		throw new Error("Personalization candidate ID must be a positive safe integer.");
	}
	const project = sanitizePersonalizationNamePart(projectPrefix, "project prefix");
	const proposalSuffix = sanitizePersonalizationNamePart(suffix, "suffix");
	const id = String(candidateId);
	// Keep both human-readable fragments while preserving the fixed prefix and
	// full candidate ID. The final value always fits sanitizeSkillName's 64-char cap.
	const availableForParts = 64 - PERSONALIZATION_MANAGED_SKILL_PREFIX.length - id.length - 3;
	const boundedSuffix = truncateNamePart(proposalSuffix, Math.min(24, availableForParts - 1));
	const boundedProject = truncateNamePart(project, availableForParts - boundedSuffix.length);
	return sanitizeSkillName(
		`${PERSONALIZATION_MANAGED_SKILL_PREFIX}-${boundedProject}-${id}-${boundedSuffix}`,
	);
}

function assertManagedSkillFileSafeForExactDelete(name: string, fileStat: Stats): void {
	if (fileStat.isSymbolicLink()) {
		throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing exact deletion.`);
	}
	if (!fileStat.isFile()) {
		throw new Error(`Managed skill "${name}" SKILL.md is not a regular file; refusing exact deletion.`);
	}
	if (fileStat.nlink !== 1) {
		throw new Error(
			`Managed skill "${name}" SKILL.md has ${fileStat.nlink} hard links; refusing exact deletion.`,
		);
	}
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function serializableStatIdentity(value: number): number | null {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function readExactManagedSkill(name: string, file: string): Promise<{ bytes: Uint8Array; stat: Stats }> {
	const pathStat = await fs.lstat(file).catch(err => {
		if (isEnoent(err)) return null;
		throw err;
	});
	if (pathStat === null) {
		throw new Error(`Managed skill "${name}" does not exist.`);
	}
	assertManagedSkillFileSafeForExactDelete(name, pathStat);

	let handle;
	try {
		handle = await fs.open(file, READ_FILE_OPEN_FLAGS);
	} catch (err) {
		if ((err as { code?: string }).code === "ELOOP") {
			throw new Error(`Managed skill "${name}" SKILL.md is a symlink; refusing exact deletion.`);
		}
		throw err;
	}
	try {
		const openStat = await handle.stat();
		assertManagedSkillFileSafeForExactDelete(name, openStat);
		if (!sameFileIdentity(pathStat, openStat)) {
			throw new Error(`Managed skill "${name}" changed identity while it was being inspected; refusing exact deletion.`);
		}
		const bytes = new Uint8Array(await handle.readFile());
		if (bytes.byteLength !== openStat.size) {
			throw new Error(`Managed skill "${name}" changed size while it was being inspected; refusing exact deletion.`);
		}
		return { bytes, stat: openStat };
	} finally {
		await handle.close();
	}
}

/**
 * Create a personalization-managed skill without any update path and return
 * enough identity to prove that a later rollback targets the same file.
 */
export async function createPersonalizationManagedSkill(
	input: CreatePersonalizationManagedSkillInput,
): Promise<ManagedSkillArtifactIdentity> {
	const name = getPersonalizationManagedSkillName(input.projectPrefix, input.candidateId, input.suffix);
	const managedRoot = getManagedSkillsDir(input.agentDir);
	const written = await writeManagedSkill({
		action: "create",
		name,
		description: input.description,
		body: input.body,
		agentDir: input.agentDir,
	});
	await assertManagedRootSafe(input.agentDir);
	const canonicalRoot = await fs.realpath(managedRoot);
	const canonicalPath = await fs.realpath(written.path);
	const expectedPath = path.join(canonicalRoot, name, "SKILL.md");
	if (canonicalPath !== expectedPath) {
		throw new Error(`Personalization managed skill "${name}" escaped the canonical managed root.`);
	}
	const { bytes, stat } = await readExactManagedSkill(name, written.path);
	return {
		name,
		path: canonicalPath,
		contentSha256: Bun.SHA256.hash(bytes, "hex"),
		size: bytes.byteLength,
		dev: serializableStatIdentity(stat.dev),
		ino: serializableStatIdentity(stat.ino),
	};
}

/**
 * Retry a candidate-specific create after a crash. Existing content is adopted
 * only at the deterministic reserved path and only after the same exact-file
 * checks used by rollback, plus a byte-for-byte comparison with regenerated content.
 */
export async function recoverPersonalizationManagedSkill(
	input: CreatePersonalizationManagedSkillInput,
	expectedArtifact?: ManagedSkillArtifactIdentity | null,
): Promise<ManagedSkillArtifactIdentity> {
	const name = getPersonalizationManagedSkillName(input.projectPrefix, input.candidateId, input.suffix);
	try {
		return await createPersonalizationManagedSkill(input);
	} catch (error) {
		if (!hasErrnoCode(error, "EEXIST")) throw error;
	}

	const expectedContent = Buffer.from(buildManagedSkillContent(name, input.description, input.body), "utf8");
	const managedRoot = getManagedSkillsDir(input.agentDir);
	await assertManagedRootSafe(input.agentDir);
	const canonicalRoot = await fs.realpath(managedRoot);
	const dir = path.join(managedRoot, name);
	const dirStat = await fs.lstat(dir);
	if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
		throw new Error(`Managed skill "${name}" retry path is not a regular directory; refusing recovery.`);
	}
	const canonicalDir = await fs.realpath(dir);
	if (canonicalDir !== path.join(canonicalRoot, name)) {
		throw new Error(`Managed skill "${name}" retry directory escaped the canonical managed root.`);
	}
	const entries = await fs.readdir(dir);
	if (entries.length !== 1 || entries[0] !== "SKILL.md") {
		throw new Error(`Managed skill "${name}" retry directory contains unexpected entries; refusing recovery.`);
	}
	const file = path.join(dir, "SKILL.md");
	const canonicalPath = await fs.realpath(file);
	const expectedPath = path.join(canonicalRoot, name, "SKILL.md");
	if (canonicalPath !== expectedPath) {
		throw new Error(`Managed skill "${name}" retry path escaped the canonical managed root.`);
	}
	const snapshot = await readExactManagedSkill(name, file);
	const actualContent = Buffer.from(snapshot.bytes);
	if (!actualContent.equals(expectedContent)) {
		throw new Error(`Managed skill "${name}" existing content does not match the generated candidate; refusing recovery.`);
	}
	const artifact: ManagedSkillArtifactIdentity = {
		name,
		path: canonicalPath,
		contentSha256: Bun.SHA256.hash(snapshot.bytes, "hex"),
		size: snapshot.bytes.byteLength,
		dev: serializableStatIdentity(snapshot.stat.dev),
		ino: serializableStatIdentity(snapshot.stat.ino),
	};
	if (expectedArtifact) {
		assertExpectedArtifactIdentity(expectedArtifact);
		if (
			expectedArtifact.name !== artifact.name ||
			expectedArtifact.path !== artifact.path ||
			expectedArtifact.contentSha256 !== artifact.contentSha256 ||
			expectedArtifact.size !== artifact.size ||
			(expectedArtifact.dev !== null && expectedArtifact.dev !== artifact.dev) ||
			(expectedArtifact.ino !== null && expectedArtifact.ino !== artifact.ino)
		) {
			throw new Error(`Managed skill "${name}" retry identity does not match the persisted artifact; refusing recovery.`);
		}
	}
	const finalStat = await fs.lstat(file);
	assertManagedSkillFileSafeForExactDelete(name, finalStat);
	if (!sameFileIdentity(snapshot.stat, finalStat)) {
		throw new Error(`Managed skill "${name}" changed identity during recovery; refusing adoption.`);
	}
	return artifact;
}

function assertExpectedArtifactIdentity(expected: ManagedSkillArtifactIdentity): void {
	if (!/^[a-f0-9]{64}$/.test(expected.contentSha256)) {
		throw new Error("Expected managed-skill content SHA-256 must be 64 lowercase hexadecimal characters.");
	}
	if (!Number.isSafeInteger(expected.size) || expected.size < 0) {
		throw new Error("Expected managed-skill size must be a non-negative safe integer.");
	}
	for (const [label, value] of [
		["device", expected.dev],
		["inode", expected.ino],
	] as const) {
		if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
			throw new Error(`Expected managed-skill ${label} must be null or a non-negative safe integer.`);
		}
	}
}

/**
 * Delete a personalization-managed skill only when every persisted identity
 * field still describes the exact canonical regular file created earlier.
 */
export async function deleteManagedSkillIfExact(expected: DeleteManagedSkillIfExactInput): Promise<void> {
	const safe = sanitizeSkillName(expected.name);
	if (safe !== expected.name) {
		throw new Error("Expected managed-skill name must already be in canonical sanitized form.");
	}
	assertExpectedArtifactIdentity(expected);
	const managedRoot = getManagedSkillsDir(expected.agentDir);
	await serializeSkillMutation(getSkillMutationKey(managedRoot, safe), async () => {
		await assertManagedRootSafe(expected.agentDir);
		const canonicalRoot = await fs.realpath(managedRoot).catch(err => {
			if (isEnoent(err)) throw new Error(`Managed skill "${safe}" does not exist.`);
			throw err;
		});
		const expectedCanonicalPath = path.join(canonicalRoot, safe, "SKILL.md");
		if (expected.path !== expectedCanonicalPath) {
			throw new Error(`Managed skill "${safe}" canonical path does not match the persisted exact path.`);
		}

		const dir = path.join(managedRoot, safe);
		const dirStat = await fs.lstat(dir).catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (dirStat === null) {
			throw new Error(`Managed skill "${safe}" does not exist.`);
		}
		if (dirStat.isSymbolicLink()) {
			throw new Error(`Managed skill "${safe}" directory is a symlink; refusing exact deletion.`);
		}
		if (!dirStat.isDirectory()) {
			throw new Error(`Managed skill "${safe}" path is not a directory; refusing exact deletion.`);
		}
		const canonicalDir = await fs.realpath(dir);
		if (canonicalDir !== path.dirname(expectedCanonicalPath)) {
			throw new Error(`Managed skill "${safe}" directory escaped the canonical managed root.`);
		}
		const relativeDir = path.relative(canonicalRoot, canonicalDir);
		if (!relativeDir || relativeDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDir)) {
			throw new Error(`Managed skill "${safe}" directory is not contained by the canonical managed root.`);
		}

		const entries = await fs.readdir(dir);
		if (entries.length !== 1 || entries[0] !== "SKILL.md") {
			throw new Error(`Managed skill "${safe}" directory contains unexpected entries; refusing exact deletion.`);
		}
		const file = path.join(dir, "SKILL.md");
		const snapshot = await readExactManagedSkill(safe, file);
		const canonicalFile = await fs.realpath(file).catch(err => {
			if (isEnoent(err)) throw new Error(`Managed skill "${safe}" does not exist.`);
			throw err;
		});
		if (canonicalFile !== expectedCanonicalPath) {
			throw new Error(`Managed skill "${safe}" canonical file path does not match the persisted exact path.`);
		}

		const { bytes, stat } = snapshot;
		if (stat.size !== expected.size || bytes.byteLength !== expected.size) {
			throw new Error(`Managed skill "${safe}" size changed; refusing exact deletion.`);
		}
		const contentSha256 = Bun.SHA256.hash(bytes, "hex");
		if (contentSha256 !== expected.contentSha256) {
			throw new Error(`Managed skill "${safe}" content hash changed; refusing exact deletion.`);
		}
		if ((expected.dev !== null && stat.dev !== expected.dev) || (expected.ino !== null && stat.ino !== expected.ino)) {
			throw new Error(`Managed skill "${safe}" filesystem identity changed; refusing exact deletion.`);
		}

		const finalStat = await fs.lstat(file);
		assertManagedSkillFileSafeForExactDelete(safe, finalStat);
		if (!sameFileIdentity(stat, finalStat)) {
			throw new Error(`Managed skill "${safe}" changed identity before deletion; refusing exact deletion.`);
		}
		await fs.unlink(file);
		await fs.rmdir(dir);
	});
}
