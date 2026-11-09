import { CommandId, ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /** Files an idle thread under another project; its next turn runs in that project's root. */
    readonly move: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;

  const refuse = (reason: string) => new ThreadProjectMoveError({ reason });
  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail("Could not read the thread.")));
      const thread = records.thread;
      if (thread.deletedAt !== null) return yield* refuse("Thread not found.");
      if (thread.archivedAt !== null) return yield* refuse("Unarchive the thread first.");
      if (thread.projectId === input.projectId) {
        return yield* refuse("The thread is already in that project.");
      }
      if (threadHasUnfinishedWork(records)) {
        return yield* refuse(`"${thread.title}" is still working. Finish or stop it first.`);
      }
      const destination = yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(fail("Could not read the destination project.")));
      if (Option.isNone(destination) || destination.value.deletedAt !== null) {
        return yield* refuse("The destination project no longer exists.");
      }
      // No project threads keep their own folder in worktreePath; that folder simply stays behind.
      if (
        thread.worktreePath !== null &&
        !(yield* managedFolders.isScratchProject(thread.projectId))
      ) {
        return yield* refuse("Threads with their own worktree cannot move to another project yet.");
      }

      const commandId = CommandId.make(`thread-project-move:${yield* random.uuidV4()}`);
      yield* threads
        .moveThreadToProject({
          threadId: thread.id,
          projectId: input.projectId,
          commandId,
          afterMove: scheduledTasks
            .moveThreadTasks({ threadIds: [thread.id], projectId: input.projectId })
            .pipe(Effect.ignoreCause({ log: true })),
        })
        .pipe(
          Effect.mapError((cause) => new ThreadProjectMoveError({ reason: cause.message, cause })),
        );
      return { projectId: input.projectId };
    },
  );

  return ThreadProjectMove.of({ move });
});

export const layer = Layer.effect(ThreadProjectMove, make);
