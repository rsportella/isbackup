export type JobRunStatus = "idle" | "running" | "success" | "error" | "cancelled";

export interface JobRunState {
  status: JobRunStatus;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  outputFile?: string;
}

const runState = new Map<string, JobRunState>();

export function getJobState(name: string): JobRunState {
  return runState.get(name) ?? { status: "idle" };
}

export function setJobState(name: string, state: JobRunState): void {
  runState.set(name, state);
}
