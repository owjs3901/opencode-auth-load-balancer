export interface PendingRef {
  workspace: string
  providerID: string
  sessionID: string
  messageID: string
}

/** Durable scheduling metadata. Prompt content remains owned by OpenCode. */
export interface PendingTurn extends PendingRef {
  key: string
  createdAt: number
  updatedAt: number
  nextCheckAt: number
  resumeAt: number | null
}

export interface PendingFile {
  version: 1
  turns: PendingTurn[]
}

export interface PendingSchedule {
  now: number
  nextCheckAt: number
  resumeAt: number | null
}
