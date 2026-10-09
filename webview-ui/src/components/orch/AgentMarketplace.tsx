import type { AgentDefinition } from "../../types/messages";

interface AgentMarketplaceProps {
  agents: AgentDefinition[];
  onAddAgent: (agentId: string) => void;
  disabled: boolean;
}

export function AgentMarketplace({ agents, onAddAgent, disabled }: AgentMarketplaceProps) {
  if (agents.length === 0) {
    return (
      <div className="text-center py-6 opacity-50">
        <div className="text-2xl mb-2">🏪</div>
        <p className="text-xs">Loading agents...</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {agents.map(a => (
        <div
          key={a.id}
          onClick={() => !disabled && onAddAgent(a.id)}
          className={`
            p-3 bg-vsc-header border border-vsc-border rounded-lg transition-colors
            ${disabled ? "opacity-50" : "cursor-pointer hover:bg-vsc-hover"}
          `}
        >
          <div className="flex items-center gap-2 mb-1">
            <span>{a.icon}</span>
            <span className="text-xs font-semibold">{a.name}</span>
            <span className="text-[10px] opacity-40 ml-auto">{a.source}</span>
          </div>
          <div className="text-[11px] opacity-60 line-clamp-2">{a.description}</div>
          {!disabled && (
            <div className="text-[10px] opacity-40 mt-1">Click to add ➕</div>
          )}
        </div>
      ))}
    </div>
  );
}
