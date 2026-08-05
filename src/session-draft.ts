export interface DraftSessionState {
  draft: boolean;
  closed: boolean;
}

export function findReusableDraft<T extends DraftSessionState>(sessions: T[]): T | undefined {
  return sessions.find((session) => session.draft && !session.closed);
}

export function shouldPromoteDraft(promptText: string): boolean {
  return !promptText.trimStart().startsWith("/");
}
