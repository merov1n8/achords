import { api } from "../api.ts";
import { usePoll } from "../poll.ts";
import type { Agent } from "../types.ts";

export function Agents() {
  const agents = usePoll(() => api<Agent[]>("/api/agents"), 10000);
  return (
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Name</th>
          <th>Role</th>
          <th>Workspace</th>
        </tr>
      </thead>
      <tbody>
        {agents.data?.map((a) => (
          <tr key={a.id}>
            <td>
              <code>{a.id}</code>
            </td>
            <td>{a.name}</td>
            <td>{a.role}</td>
            <td>{a.workspace}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
