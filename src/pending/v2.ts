import type { Plugin } from '@opencode/plugin'

import type { PendingResumeClient } from './coordinator'

export function createV2ResumeClient(ctx: Plugin.Context): PendingResumeClient {
  return {
    async resumePending(turn) {
      try {
        const messages = await ctx.session.context({
          sessionID: turn.sessionID as Parameters<
            typeof ctx.session.context
          >[0]['sessionID'],
        })
        const index = messages.findIndex(
          (message) => message.id === turn.messageID && message.type === 'user',
        )
        if (index < 0) return 'obsolete'
        // A later user turn or a final assistant response makes this reference stale.
        const completed = messages
          .slice(index + 1)
          .some(
            (message) =>
              message.type === 'user' ||
              (message.type === 'assistant' &&
                message.finish !== undefined &&
                message.finish !== 'tool-calls' &&
                message.finish !== 'error' &&
                !message.error),
          )
        if (completed) return 'obsolete'
        await ctx.session.prompt({
          sessionID: turn.sessionID as Parameters<
            typeof ctx.session.prompt
          >[0]['sessionID'],
          id: turn.messageID as Parameters<typeof ctx.session.prompt>[0]['id'],
          // V2 admission reconciles an existing ID before preparing text/files.
          // The durable original payload remains owned by the host.
          text: '',
          resume: true,
        })
        return 'resumed'
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          '_tag' in error &&
          (error._tag === 'SessionNotFoundError' ||
            error._tag === 'MessageNotFoundError')
        )
          return 'obsolete'
        throw error
      }
    },
  }
}
