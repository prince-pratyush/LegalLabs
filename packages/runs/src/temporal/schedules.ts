import { nextScheduledRun, type Schedule } from "@legallabs/contracts";
import {
  type Client,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  type ScheduleSpec,
} from "@temporalio/client";
import { TASK_QUEUE } from "./engine.js";

const DAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export const scheduleId = (id: string) => `sched:${id}`;

/**
 * A Temporal calendar at the wall-clock time in the schedule's own zone, so daylight saving
 * moves the fire with it. Every-N-days fires daily; the fire handler skips the other days.
 */
export function toTemporalSpec(schedule: Schedule): ScheduleSpec {
  const [hour, minute] = schedule.time_local.split(":").map(Number) as [number, number];
  const weekdays = schedule.rule === "weekly" ? schedule.params.weekdays : undefined;
  return {
    calendars: [
      {
        hour,
        minute,
        ...(weekdays ? { dayOfWeek: weekdays.map((d) => DAYS[d] as (typeof DAYS)[number]) } : {}),
      },
    ],
    timezone: schedule.tz,
  };
}

export interface SchedulerPort {
  upsert(id: string, schedule: Schedule): Promise<{ next_run_at: Date | null }>;
  pause(id: string, note: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Schedules held by Temporal, so they keep firing while the API is down. */
export function createTemporalScheduler(client: Client, taskQueue = TASK_QUEUE): SchedulerPort {
  const handle = (id: string) => client.schedule.getHandle(scheduleId(id));
  return {
    async upsert(id, schedule) {
      const spec = toTemporalSpec(schedule);
      const action = {
        type: "startWorkflow" as const,
        workflowType: "scheduledFire",
        taskQueue,
        args: [{ scheduleId: id }],
      };
      try {
        await handle(id).update((prev) => ({ ...prev, spec, action }));
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) throw err;
        await client.schedule.create({
          scheduleId: scheduleId(id),
          spec,
          action,
          policies: { overlap: ScheduleOverlapPolicy.SKIP },
        });
      }
      return { next_run_at: nextScheduledRun(schedule, new Date()) };
    },
    pause: (id, note) => handle(id).pause(note),
    resume: (id) => handle(id).unpause(),
    async remove(id) {
      try {
        await handle(id).delete();
      } catch (err) {
        if (!(err instanceof ScheduleNotFoundError)) throw err;
      }
    },
  };
}
