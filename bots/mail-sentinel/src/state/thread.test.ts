import { describe, expect, it } from "vitest";
import { loadGolden } from "../__fixtures__/load.js";
import { migrateState } from "./schema.js";
import { queueAmberAlert, resolvePendingAmberAlerts } from "./thread.js";

describe("state/thread", () => {
  it("dedupes queueAmberAlert calls for the same alert id", () => {
    expect(
      (() => {
        const s = migrateState({});
        queueAmberAlert(s, "alert-1");
        queueAmberAlert(s, "alert-1");
        queueAmberAlert(s, "alert-2");
        return s.digest;
      })(),
    ).toEqual(loadGolden("queueAmberAlert.new"));
  });

  it("matches the resolvePendingAmberAlerts golden fixture", () => {
    expect(
      resolvePendingAmberAlerts(
        migrateState({
          alerts: [
            { alertId: "a1", zone: "amber", sentAt: "2026-04-08T10:00:00Z" },
            { alertId: "a2", zone: "red", sentAt: "2026-04-08T11:00:00Z" },
          ],
          digest: { pendingAmber: ["a1", "a2", "a3-missing"] },
        }),
      ),
    ).toEqual(loadGolden("resolvePendingAmberAlerts"));
  });
});
