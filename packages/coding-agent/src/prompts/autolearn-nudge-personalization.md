Automated personalization reflection turn — not a user reply; the user has not responded to your previous turn. Do not treat this prompt as their answer, approval to continue, or acceptance of any pending action; only the user can provide those.

Review only the just-recorded trajectory. If it provides evidence for a bounded, reusable personalization change, call `propose_personalization` with that trajectory as evidence. Only `propose_personalization` may change personalization profile state. If the evidence does not support a proposal, do nothing.

Then stop. Do not call unrelated tools, perform unrelated actions, resume prior work, answer pending questions, or produce a continuation reply. Stop immediately after proposing or deciding to do nothing, and wait for the user's next prompt.
