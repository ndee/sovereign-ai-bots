import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkinAdd,
  checkinLatest,
  checkinList,
  resistanceAdd,
  resistanceList,
  resistanceResolve,
  reviewWeekly,
  stepComplete,
  stepList,
  stepNext,
  wishAdd,
  wishArchive,
  wishComplete,
  wishList,
  wishPause,
  wishShow,
} from "./commands.js";

const writeRuntimeConfig = async (root: string): Promise<string> => {
  const configPath = join(root, "runtime.json");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      sovereignTools: {
        instances: [
          {
            id: "reality-alignment-core",
            config: {
              agentId: "reality-alignment",
              statePath: "data/reality-alignment-state.json",
            },
          },
        ],
      },
      openclawProfile: {
        agents: [{ id: "reality-alignment", workspace }],
      },
    }),
    "utf8",
  );
  return configPath;
};

describe("reality-alignment/commands", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reality-alignment-commands-"));
    configPath = await writeRuntimeConfig(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseOptions = () => ({
    json: false,
    instance: "reality-alignment-core",
    configPath,
  });

  it("requires --instance", async () => {
    await expect(wishAdd({ ...baseOptions(), instance: "", title: "x" })).rejects.toThrow(
      "Expected --instance <id>",
    );
    await expect(wishList({ ...baseOptions(), instance: "" })).rejects.toThrow(
      "Expected --instance <id>",
    );
  });

  it("supports the full wish lifecycle", async () => {
    const added = await wishAdd({
      ...baseOptions(),
      title: "Move toward Indonesia",
      description: "calm path",
    });
    expect(added.wish.status).toBe("active");

    const listed = await wishList(baseOptions());
    expect(listed.wishes).toHaveLength(1);

    const shown = await wishShow({ ...baseOptions(), query: added.wish.id });
    expect(shown.wish.title).toBe("Move toward Indonesia");

    const paused = await wishPause({ ...baseOptions(), query: added.wish.id });
    expect(paused.wish.status).toBe("paused");

    const completed = await wishComplete({ ...baseOptions(), query: added.wish.id });
    expect(completed.wish.status).toBe("completed");

    const archived = await wishArchive({ ...baseOptions(), query: added.wish.id });
    expect(archived.wish.status).toBe("archived");
  });

  it("rejects wish add without title and show without match", async () => {
    await expect(wishAdd(baseOptions())).rejects.toThrow("Expected a non-empty value for --title");
    await expect(wishShow({ ...baseOptions(), query: "missing" })).rejects.toThrow(
      "No wish matched 'missing'",
    );
  });

  it("manages check-ins with optional wish linkage", async () => {
    const wish = await wishAdd({ ...baseOptions(), title: "Ship it" });
    const empty = await checkinLatest(baseOptions());
    expect(empty.checkin).toBeUndefined();
    const added = await checkinAdd({
      ...baseOptions(),
      energy: 3,
      clarity: 3,
      congruence: 3,
      resistance: 3,
      wish: wish.wish.id,
      note: "noted",
    });
    expect(added.checkin.linkedWishIds).toEqual([wish.wish.id]);
    const ignored = await checkinAdd({
      ...baseOptions(),
      energy: 3,
      clarity: 3,
      congruence: 3,
      resistance: 3,
      wish: "  ",
    });
    expect(ignored.checkin.linkedWishIds).toEqual([]);
    const unmatched = await checkinAdd({
      ...baseOptions(),
      energy: 3,
      clarity: 3,
      congruence: 3,
      resistance: 3,
      wish: "no-match",
    });
    expect(unmatched.checkin.linkedWishIds).toEqual([]);

    const list = await checkinList(baseOptions());
    expect(list.checkins).toHaveLength(3);
    const latest = await checkinLatest(baseOptions());
    expect(latest.checkin?.id).toBeDefined();
  });

  it("tracks and resolves resistance", async () => {
    const created = await resistanceAdd({ ...baseOptions(), label: "delay" });
    expect(created.created).toBe(true);
    const incremented = await resistanceAdd({
      ...baseOptions(),
      label: "delay",
      description: "deferring",
    });
    expect(incremented.created).toBe(false);
    expect(incremented.pattern.recurrenceCount).toBe(2);
    const list = await resistanceList(baseOptions());
    expect(list.resistance).toHaveLength(1);
    const resolved = await resistanceResolve({ ...baseOptions(), query: "delay" });
    expect(resolved.pattern.status).toBe("reduced");
  });

  it("generates, lists, and completes steps", async () => {
    const wish = await wishAdd({ ...baseOptions(), title: "Build" });
    const step = await stepNext(baseOptions());
    expect(step.wish.id).toBe(wish.wish.id);
    const targeted = await stepNext({ ...baseOptions(), wish: wish.wish.id });
    expect(targeted.wish.id).toBe(wish.wish.id);
    const list = await stepList(baseOptions());
    expect(list.steps).toHaveLength(2);
    const completed = await stepComplete({ ...baseOptions(), query: step.step.id });
    expect(completed.step.status).toBe("done");
  });

  it("returns a weekly review summary", async () => {
    await wishAdd({ ...baseOptions(), title: "Build" });
    await checkinAdd({
      ...baseOptions(),
      energy: 3,
      clarity: 3,
      congruence: 3,
      resistance: 3,
    });
    const review = await reviewWeekly(baseOptions());
    expect(review.review.activeWishes).toHaveLength(1);
    expect(review.formatted).toMatch(/Weekly Review/);
  });
});
