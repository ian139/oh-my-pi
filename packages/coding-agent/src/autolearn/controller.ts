/**
 * Auto-learn and personalization reflection session controller (experimental).
 *
 * Subscribes to the session event stream and, after an eligible terminal turn,
 * optionally auto-runs one synthetic capture turn. Auto-Learn passive mode is
 * intentionally prompt-cache neutral: the standing system guidance remains
 * available, but no hidden mid-session reminder is inserted into the conversation.
 *
 * Installed once per top-level session (taskDepth 0). The subscription lives
 * for the session's lifetime — `newSession` resets the session in place
 * without re-running startup — so the controller needs no disposal.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import autolearnNudgeCombined from "../prompts/autolearn-nudge-combined.md" with { type: "text" };
import autolearnNudgePersonalization from "../prompts/autolearn-nudge-personalization.md" with { type: "text" };
import autolearnGuidance from "../prompts/system/autolearn-guidance.md" with { type: "text" };
import autolearnGuidanceLearn from "../prompts/system/autolearn-guidance-learn.md" with { type: "text" };
import autolearnNudgeAutoContinue from "../prompts/system/autolearn-nudge-autocontinue.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";

const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnNudgeAutoContinue.trim();
const AUTOLEARN_NUDGE_PERSONALIZATION = autolearnNudgePersonalization.trim();
const AUTOLEARN_NUDGE_COMBINED = autolearnNudgeCombined.trim();
const DEFAULT_MIN_TOOL_CALLS = 5;

/**
 * Build the standing auto-learn guidance for the system prompt from the tools
 * actually present in the active set, or null when `manage_skill` is absent.
 *
 * Driven by tool presence rather than live settings: the `learn`/`manage_skill`
 * registry is built ONCE at session start (and only for top-level sessions), so
 * keying the guidance on `autolearn.enabled` would let a mid-session enable — or
 * a subagent that filtered the tools out — inject guidance pointing at tools the
 * session never built. The `learn` addendum is included only when the `learn`
 * tool is present (it requires a memory backend).
 */
export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnGuidance.trim()];
	if (available.learn) parts.push(autolearnGuidanceLearn.trim());
	return parts.join("\n\n");
}

export interface PersonalizationTrajectorySignal {
	substantive: boolean;
	negative: boolean;
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
	capture: (content: string) => Promise<void>;
	/**
	 * Returns the trajectory recorded for the current terminal turn. The
	 * personalization subscriber must be installed before this controller.
	 */
	getPersonalizationTrajectory?: () => PersonalizationTrajectorySignal | null;
}

interface CapturePurposes {
	autoLearn: boolean;
	personalization: boolean;
}

function capturePrompt(purposes: CapturePurposes): string {
	if (purposes.autoLearn && purposes.personalization) return AUTOLEARN_NUDGE_COMBINED;
	return purposes.personalization ? AUTOLEARN_NUDGE_PERSONALIZATION : AUTOLEARN_NUDGE_AUTOCONTINUE;
}

export class AutoLearnController {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #capture: (content: string) => Promise<void>;
	readonly #getPersonalizationTrajectory: (() => PersonalizationTrajectorySignal | null) | undefined;
	#toolCalls = 0;
	/**
	 * Whether the in-flight turn BEGAN while goal mode was active. Captured at
	 * agent_start because a `goal` tool can complete or drop the goal mid-turn,
	 * clearing the live flag before agent_end — so the end-of-turn state alone
	 * would let a goal-continuation turn slip through and get nudged.
	 */
	#turnStartedInGoalMode = false;
	/** Preserve plan-mode eligibility across non-terminal continuations. */
	#turnStartedInPlanMode = false;
	/** Prevent overlapping private capture runs while real primary turns continue. */
	#captureInFlight = false;
	/** Purposes coalesced from eligible primary stops while capture is running. */
	#capturePending: CapturePurposes | null = null;

	constructor(options: AutoLearnControllerOptions) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#capture = options.capture;
		this.#getPersonalizationTrajectory = options.getPersonalizationTrajectory;
		// The listener closure captures `this`, so the session's listener array
		// keeps the controller alive — no stored unsubscribe needed.
		this.#session.subscribe(event => this.#onEvent(event));
	}

	#onEvent(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			// A non-terminal continuation can emit another start. Preserve whether
			// any segment of the still-running primary turn began in a guarded mode.
			this.#turnStartedInGoalMode ||= this.#session.getGoalModeState()?.enabled === true;
			this.#turnStartedInPlanMode ||= this.#session.getPlanModeState()?.enabled === true;
			return;
		}
		if (event.type === "tool_execution_end") {
			this.#toolCalls++;
			return;
		}
		if (event.type === "agent_end") {
			this.#onAgentEnd(event);
		}
	}

	#onAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// A scheduled continuation belongs to the same primary turn. Keep its
		// counters and evaluate only the final settle.
		if (event.isTerminal === false) return;

		// Snapshot and reset exactly once per terminal turn. Ineligible and
		// disabled turns must not let state accumulate into a later turn.
		const toolCalls = this.#toolCalls;
		this.#toolCalls = 0;
		const startedInGoalMode = this.#turnStartedInGoalMode;
		this.#turnStartedInGoalMode = false;
		const startedInPlanMode = this.#turnStartedInPlanMode;
		this.#turnStartedInPlanMode = false;

		// Never reflect on a turn that ended in an abort (ESC, cancel, etc.).
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && typeof message === "object" && "role" in message && message.role === "assistant") {
				if ("stopReason" in message && message.stopReason === "aborted") {
					return;
				}
				break;
			}
		}
		// Never interrupt plan-mode review or divert a goal loop.
		if (startedInPlanMode || this.#session.getPlanModeState()?.enabled) return;
		if (startedInGoalMode || this.#session.getGoalModeState()?.enabled) return;

		const minToolCalls = this.#settings.get("autolearn.minToolCalls") ?? DEFAULT_MIN_TOOL_CALLS;
		const autoLearn =
			this.#settings.get("autolearn.enabled") === true &&
			this.#settings.get("autolearn.autoContinue") === true &&
			toolCalls >= minToolCalls;

		let personalization = false;
		if (
			this.#settings.get("personalization.enabled") === true &&
			this.#settings.get("personalization.autoReflect") === true
		) {
			const trajectory = this.#getPersonalizationTrajectory?.();
			personalization = trajectory?.substantive === true || trajectory?.negative === true;
		}

		if (!autoLearn && !personalization) return;
		this.#queueCapture({ autoLearn, personalization });
	}

	#queueCapture(purposes: CapturePurposes): void {
		if (this.#captureInFlight) {
			const pending = this.#capturePending;
			this.#capturePending = pending
				? {
						autoLearn: pending.autoLearn || purposes.autoLearn,
						personalization: pending.personalization || purposes.personalization,
					}
				: purposes;
			return;
		}
		this.#startCapture(purposes);
	}

	#startCapture(purposes: CapturePurposes): void {
		this.#captureInFlight = true;
		void this.#capture(capturePrompt(purposes))
			.catch(err => {
				logger.warn("auto-learn reflection capture failed", { err });
			})
			.finally(() => {
				this.#captureInFlight = false;
				const pending = this.#capturePending;
				if (!pending) return;
				this.#capturePending = null;
				this.#startCapture(pending);
			});
	}
}
