import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import {
  archiveLaneRpc,
  archiveLeftoversRpc,
  archiveRpc,
  archiveWorkspacesRpc,
  assignRpc,
  branchesRpc,
  browseRpc,
  cancelHandoffRpc,
  dismissErrorRpc,
  handoffRpc,
  overviewRpc,
  providerCatalogRpc,
  readDocRpc,
  resolveTargetsRpc,
  rolesRpc,
  saveAgentsRpc,
  startRpc,
  startSuccessorRpc,
  syncRpc,
  workspacesRpc,
} from "./shared/contracts";
import { workCardSchema } from "./server/roles";
import {
  archive,
  archiveLane,
  archiveLeftoverWorkers,
  archiveWorkspaces,
  assign,
  autoApprovePermission,
  bootstrapFor,
  browse,
  cancelHandoff,
  dismissError,
  dispatchWork,
  handoff,
  keepWatching,
  listWorkspaces,
  onAgentCreated,
  onSessionArchived,
  onTurnEnded,
  onWorkerTurnEnded,
  overview,
  prepareHome,
  providerCatalogView,
  readDoc,
  resolveTargets,
  rolesView,
  saveAgents,
  start,
  startSuccessor,
  stopWatching,
  sync,
  targetBranches,
  workToolDescription,
} from "./server/service";

export default function contribute(server: PluginServerContext) {
  for (const problem of prepareHome()) console.error(`[dispatch-center] ${problem}`);

  server.handle(overviewRpc, (_input, { paseo }) => {
    keepWatching(paseo);
    return overview(paseo);
  });
  server.handle(syncRpc, () => sync());
  server.handle(startRpc, (input, { paseo }) => start(paseo, input));
  server.handle(handoffRpc, (input, { paseo }) => handoff(paseo, input));
  server.handle(startSuccessorRpc, (input, { paseo }) => startSuccessor(paseo, input));
  server.handle(cancelHandoffRpc, (input) => cancelHandoff(input));
  server.handle(dismissErrorRpc, (input) => dismissError(input));
  server.handle(archiveRpc, (input, { paseo }) => archive(paseo, input));
  server.handle(archiveLaneRpc, (input, { paseo }) => archiveLane(paseo, input));
  server.handle(archiveLeftoversRpc, (_input, { paseo }) => archiveLeftoverWorkers(paseo));
  server.handle(workspacesRpc, (_input, { paseo }) => listWorkspaces(paseo));
  server.handle(archiveWorkspacesRpc, (input, { paseo }) => archiveWorkspaces(paseo, input));
  server.handle(resolveTargetsRpc, (input) => resolveTargets(input));
  server.handle(branchesRpc, (input) => targetBranches(input));
  server.handle(assignRpc, (input, { paseo }) => assign(paseo, input));
  server.handle(browseRpc, (input, { paseo }) => browse(paseo, input));
  server.handle(readDocRpc, (input) => readDoc(input));
  server.handle(rolesRpc, (_input, { paseo }) => rolesView(paseo));
  server.handle(providerCatalogRpc, (input, { paseo }) => providerCatalogView(paseo, input));
  server.handle(saveAgentsRpc, (input) => saveAgents(input));

  // Sessions created inside a dispatcher directory get the role bootstrap; everything else is untouched.
  server.addHook("agent.create.before", async ({ request }) => {
    const bootstrap = bootstrapFor(request.config.cwd);
    if (!bootstrap) return request;
    const existing = request.config.systemPrompt?.trim();
    return {
      ...request,
      config: {
        ...request.config,
        systemPrompt: existing ? `${existing}\n\n${bootstrap.prompt}` : bootstrap.prompt,
      },
    };
  });

  // Only dispatcher sessions get dispatch_work, so workers have no way to start sub-agents through it.
  server.addHook("agent.open.before", async ({ request }) => {
    const description = workToolDescription(request.cwd);
    if (!description) return request;
    const tool = defineAgentTool({
      name: "dispatch_work",
      title: "派执行会话",
      description,
      input: workCardSchema,
      execute: async (input, { agent, paseo }) => {
        keepWatching(paseo);
        try {
          const result = await dispatchWork(paseo, input, agent.id);
          return { text: result.text, structuredContent: result };
        } catch (error) {
          return { isError: true, text: (error as Error).message };
        }
      },
    });
    return { ...request, tools: [...request.tools, tool] };
  });

  server.addHook("agent.create.after", async ({ agent }, { paseo }) => {
    keepWatching(paseo);
    await onAgentCreated(paseo, agent);
  });

  server.addHook("agent.archive.after", async ({ agent }, { paseo }) => {
    keepWatching(paseo);
    onSessionArchived(paseo, agent.id);
  });

  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    keepWatching(paseo);
    await autoApprovePermission(paseo, agent, request);
  });

  server.addHook("agent.turn.after", async (event, { paseo }) => {
    await onTurnEnded(paseo, event.agent.id, event.outcome.kind);
    onWorkerTurnEnded(paseo, event.agent, event.outcome);
  });

  return stopWatching;
}
