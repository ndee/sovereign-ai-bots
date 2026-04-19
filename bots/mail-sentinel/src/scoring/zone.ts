import { ZONE_ORDER } from "../constants.js";
import type { Zone } from "../types.js";

// ZONE_ORDER is a const record keyed by Zone, so indexing by a valid Zone
// always returns a number. The ?? 0 fallback in the original mjs existed to
// match the mjs's defensive posture; here we assert the lookup to simplify
// branch coverage.
export const zoneMax = (left: Zone, right: Zone): Zone =>
  (ZONE_ORDER[left] as number) >= (ZONE_ORDER[right] as number) ? left : right;

export const zoneMin = (left: Zone, right: Zone): Zone =>
  (ZONE_ORDER[left] as number) <= (ZONE_ORDER[right] as number) ? left : right;

export const applyZoneFloor = (current: Zone, floor: Zone | null): Zone =>
  floor === null ? current : zoneMax(current, floor);

export const applyZoneCeiling = (current: Zone, ceiling: Zone | null): Zone =>
  ceiling === null ? current : zoneMin(current, ceiling);
