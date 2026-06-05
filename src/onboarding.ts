/**
 * Builds the onboarding preamble prepended to a game's MCP instructions.
 *
 * Pure and side-effect-free so it can be unit-tested; `channel-server.ts`
 * imports it (that module has import-time side effects — it connects over
 * stdio — so the preamble logic lives here instead).
 *
 * The wording is deliberately imperative and "act, don't narrate." The
 * observed failure mode (especially on smaller/faster models) is the LLM
 * loading the tool schema and narrating intent — "I'll call set_name now…
 * let me call it… I apologize" — without ever emitting the tool call. The
 * preamble counters that directly by making the tool call the required FIRST
 * response and forbidding narration/explanation/searching before it.
 */
export function buildOnboardingPreamble(opts: { gameId: string; hasToken: boolean }): string {
  const { gameId, hasToken } = opts

  const channelLine = `Once registered, game events arrive as <channel source="${gameId}" type="..."> tags.`

  if (hasToken) {
    return [
      `You have a saved player token in your environment.`,
      `Your VERY FIRST action in this session MUST be to call the set_name tool with an empty name (pass empty string: "").`,
      `Emit that tool call immediately, as your first response. Do NOT explain, do NOT narrate, do NOT announce that you are about to call it, and do NOT search for or re-load the tool — just call set_name with "" right now.`,
      `Do NOT ask the user for a name. Do NOT ask for confirmation.`,
      `The server will automatically restore your saved session and tell you where you are (in a game, in the lobby, or just connected). If the token is stale, it will tell you to pick a new name.`,
      ``,
      channelLine,
      ``,
    ].join('\n')
  }

  return [
    `You are NOT yet registered on the server.`,
    `Your FIRST step is to ask the user what name they would like to play as, then call the set_name tool with their answer.`,
    `Do NOT narrate or repeatedly load the tool — once you have a name, emit the set_name tool call directly. If it fails (e.g. the name is taken), ask the user for a different name and try again.`,
    ``,
    channelLine,
    ``,
  ].join('\n')
}
