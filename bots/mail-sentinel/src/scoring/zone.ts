import { ZONE_ORDER } from "../constants.js";
import type { Zone } from "../types.js";

export const zoneMax = (left: Zone, right: Zone): Zone =>
  (ZONE_ORDER[left] ?? 0) >= (ZONE_ORDER[right] ?? 0) ? left : right;

export const zoneMin = (left: Zone, right: Zone): Zone =>
  (ZONE_ORDER[left] ?? 0) <= (ZONE_ORDER[right] ?? 0) ? left : right;

export const applyZoneFloor = (current: Zone, floor: Zone | null): Zone =>
  floor === null ? current : zoneMax(current, floor);

export const applyZoneCeiling = (current: Zone, ceiling: Zone | null): Zone =>
  ceiling === null ? current : zoneMin(current, ceiling);
