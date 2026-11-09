import { threadMoveDestinations } from "@t3tools/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, ProjectId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

/** Projects in the thread's environment it can move to, on a server that supports moving. */
export function threadMoveDestinationsFor(
  thread: EnvironmentThreadShell,
): ReadonlyArray<{ readonly id: ProjectId; readonly title: string }> {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId);
  if (config?.environment.capabilities.threadProjectMove !== true) return [];
  return threadMoveDestinations(
    thread,
    appAtomRegistry.get(environmentProjects.projectsAtom),
    config.scratchWorkspaceRoot,
  );
}

export async function moveThreadToProject(
  thread: EnvironmentThreadShell,
  projectId: string,
): Promise<void> {
  const title = "Could not move thread";
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, "This connection cannot change threads.");
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const result = await runAtomCommand(
    appAtomRegistry,
    projectEnvironment.moveThread,
    {
      environmentId: thread.environmentId,
      input: { threadId: thread.id, projectId: ProjectId.make(projectId) },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "Try again.");
  }
}
