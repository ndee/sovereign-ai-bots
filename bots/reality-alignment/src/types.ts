export type Score = 1 | 2 | 3 | 4 | 5;

export type WishStatus = "active" | "paused" | "completed" | "archived";

export type ResistanceStatus = "active" | "reduced" | "archived";

export type StepStatus = "open" | "done" | "skipped";

export interface Wish {
  id: string;
  title: string;
  description?: string | undefined;
  emotionalCore?: string | undefined;
  desiredState?: string | undefined;
  timeframe?: string | undefined;
  desiredLevel?: number | undefined;
  status: WishStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AlignmentCheckin {
  id: string;
  date: string;
  energyScore: Score;
  clarityScore: Score;
  congruenceScore: Score;
  resistanceScore: Score;
  level?: number | undefined;
  note?: string | undefined;
  linkedWishIds: string[];
  createdAt: string;
}

export interface ResistancePattern {
  id: string;
  label: string;
  description?: string | undefined;
  linkedWishIds: string[];
  recurrenceCount: number;
  lastSeenAt: string;
  status: ResistanceStatus;
}

export interface ActionStep {
  id: string;
  title: string;
  linkedWishId: string;
  rationale?: string | undefined;
  dueDate?: string | undefined;
  status: StepStatus;
  createdAt: string;
  completedAt?: string | undefined;
}

export interface RealityAlignmentState {
  version: number;
  wishes: Wish[];
  checkins: AlignmentCheckin[];
  resistance: ResistancePattern[];
  steps: ActionStep[];
}

export type WishSubcommand = "add" | "list" | "show" | "archive" | "complete" | "pause";
export type CheckinSubcommand = "add" | "list" | "latest";
export type ResistanceSubcommand = "add" | "list" | "resolve";
export type StepSubcommand = "next" | "list" | "complete";
export type ReviewSubcommand = "weekly";

export interface CommandOptions {
  json: boolean;
  instance?: string | undefined;
  configPath?: string | undefined;
  subcommand?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  query?: string | undefined;
  label?: string | undefined;
  note?: string | undefined;
  energy?: number | undefined;
  clarity?: number | undefined;
  congruence?: number | undefined;
  resistance?: number | undefined;
  level?: number | undefined;
  desiredLevel?: number | undefined;
  wish?: string | undefined;
  rationale?: string | undefined;
}
