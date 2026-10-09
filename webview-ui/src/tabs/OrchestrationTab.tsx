import { useState, useCallback } from "react";
import { useAppState } from "../store/AppContext";
import { SessionChips } from "../components/SessionChips";
import { AgentMarketplace } from "../components/orch/AgentMarketplace";
import { TeamRoster } from "../components/orch/TeamRoster";
import { MissionBriefing } from "../components/orch/MissionBriefing";
import { OrchMonitor } from "../components/orch/OrchMonitor";
import type { AgentDefinition } from "../types/messages";

export interface TeamSlot {
  slotId: string;
  agent: AgentDefinition;
}

export function OrchestrationTab() {
  const { state, dispatch } = useAppState();
  const [teamSlots, setTeamSlots] = useState<TeamSlot[]>([]);
  const [slotCounter, setSlotCounter] = useState(0);

  const activeSession = state.activeOrchSessionId
    ? state.orchSessions[state.activeOrchSessionId]
    : null;

  const isSessionActive = !!activeSession &&
    (activeSession.state === "active" || activeSession.state === "planning");

  const addAgent = useCallback((agentId: string) => {
    if (isSessionActive) return;
    const agent = state.agentCatalog.find(a => a.id === agentId);
    if (!agent) return;
    const newCounter = slotCounter + 1;
    setSlotCounter(newCounter);
    setTeamSlots(prev => [...prev, { slotId: `slot-${newCounter}`, agent }]);
  }, [state.agentCatalog, isSessionActive, slotCounter]);

  const removeSlot = useCallback((slotId: string) => {
    setTeamSlots(prev => prev.filter(s => s.slotId !== slotId));
  }, []);

  const reorderSlots = useCallback((fromIdx: number, toIdx: number) => {
    setTeamSlots(prev => {
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      return next;
    });
  }, []);

  const selectSession = (sid: string) => {
    dispatch({ type: "SET_ACTIVE_ORCH", sessionId: sid });
  };

  const removeSession = (sid: string) => {
    dispatch({ type: "REMOVE_ORCH", sessionId: sid });
  };

  return (
    <div className="space-y-5">
      {/* Agent Marketplace */}
      <section>
        <h3 className="text-sm font-semibold mb-2">Agent Marketplace</h3>
        <AgentMarketplace
          agents={state.agentCatalog}
          onAddAgent={addAgent}
          disabled={isSessionActive}
        />
      </section>

      {/* Team Roster */}
      <section>
        <h3 className="text-sm font-semibold mb-2">Team Roster</h3>
        <TeamRoster
          slots={teamSlots}
          models={state.availableModels}
          allModels={state.allModels}
          enabledModelIds={state.enabledModelIds}
          disabled={isSessionActive}
          onRemoveSlot={removeSlot}
          onReorder={reorderSlots}
        />
      </section>

      {/* Mission Briefing */}
      <section>
        <h3 className="text-sm font-semibold mb-2">Mission Briefing</h3>
        <MissionBriefing
          teamSlots={teamSlots}
          models={state.availableModels}
          activeSession={activeSession}
          activeSessionId={state.activeOrchSessionId}
        />
      </section>

      {/* Active Sessions */}
      <section>
        <h3 className="text-sm font-semibold mb-2">Active Sessions</h3>
        <SessionChips
          sessions={state.orchSessions}
          activeId={state.activeOrchSessionId}
          onSelect={selectSession}
          onRemove={removeSession}
          activeStates={["active", "planning"]}
        />
      </section>

      {/* Live Monitor */}
      <section>
        <h3 className="text-sm font-semibold mb-2">Live Monitor</h3>
        <OrchMonitor
          session={activeSession}
          sessionId={state.activeOrchSessionId}
        />
      </section>
    </div>
  );
}
