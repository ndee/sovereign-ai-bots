import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import { applyZoneCeiling, applyZoneFloor, zoneMax, zoneMin } from "./zone.js";

describe("scoring/zone", () => {
  it("matches the zoneMax golden fixture", () => {
    const golden = loadGolden<Record<string, string>>("zoneMax");
    expect({
      redVsAmber: zoneMax("red", "amber"),
      grayVsAmber: zoneMax("gray", "amber"),
    }).toEqual(golden);
  });

  it("matches the zoneMin golden fixture", () => {
    const golden = loadGolden<Record<string, string>>("zoneMin");
    expect({
      redVsAmber: zoneMin("red", "amber"),
      grayVsAmber: zoneMin("gray", "amber"),
    }).toEqual(golden);
  });

  it("matches the applyZoneFloor golden fixture", () => {
    const golden = loadGolden<Record<string, string>>("applyZoneFloor");
    expect({
      nullFloor: applyZoneFloor("gray", null),
      raise: applyZoneFloor("gray", "amber"),
      keep: applyZoneFloor("red", "amber"),
    }).toEqual(golden);
  });

  it("matches the applyZoneCeiling golden fixture", () => {
    const golden = loadGolden<Record<string, string>>("applyZoneCeiling");
    expect({
      nullCeiling: applyZoneCeiling("red", null),
      lower: applyZoneCeiling("red", "amber"),
      keep: applyZoneCeiling("gray", "amber"),
    }).toEqual(golden);
  });
});
