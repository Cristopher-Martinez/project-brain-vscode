import { useAppState } from "../store/AppContext";

export function Header() {
  const { state } = useAppState();
  const { agentEmoji, agentName, branch } = state.stats;

  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-vsc-border bg-vsc-header">
      <span className="text-[28px]">{agentEmoji}</span>
      <div className="text-lg font-bold">{agentName} HQ</div>
      <span className="ml-auto text-xs opacity-60">Branch: {branch}</span>
    </div>
  );
}
