import { log } from "./logger";
import { OrchestrationSession } from "./orchestration-session";
import { OrchUiState } from "./orchestration-state";

export class OrchestrationManager {
  private sessions = new Map<string, OrchestrationSession>();
  private states = new Map<string, OrchUiState>();

  public createSession(sessionId: string, session: OrchestrationSession): void {
    this.sessions.set(sessionId, session);
    log(`[OrchestrationManager] Created session ${sessionId}`);
  }

  public getSession(sessionId: string): OrchestrationSession | undefined {
    return this.sessions.get(sessionId);
  }

  public removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.states.delete(sessionId);
    log(`[OrchestrationManager] Removed session ${sessionId}`);
  }

  public setState(sessionId: string, state: OrchUiState): void {
    this.states.set(sessionId, state);
  }

  public getState(sessionId: string): OrchUiState | undefined {
    return this.states.get(sessionId);
  }

  public getAllStates(): Map<string, OrchUiState> {
    return this.states;
  }
}
