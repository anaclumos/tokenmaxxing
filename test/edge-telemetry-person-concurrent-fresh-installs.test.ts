import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { type SentEvent, distinctIds, hermeticEnv, installIdOf, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "eight fresh installs whose first commands run at the same moment get eight different install IDs, and each daily send goes out as its own person",
  async () => {
    const host = startStubHost();
    try {
      const installs = Array.from({ length: 8 }, () => freshHomes());
      await Promise.all(installs.map((homes) => run(["status", "--cached"], hermeticEnv(homes, host.url))));
      const sends: Array<{ installId: string; sent: SentEvent[] }> = [];
      for (const homes of installs) {
        const installId = installIdOf(homes);
        writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
        const from = host.requests.length;
        await run(["check"], hermeticEnv(homes, host.url));
        sends.push({ installId, sent: sentEvents(host, from) });
      }

      expect(new Set(sends.map((send) => send.installId)).size).toBe(8);
      expect(sends.map((send) => distinctIds(send.sent))).toEqual(sends.map((send) => [send.installId]));
      expect(sends.flatMap((send) => personFaults(send.sent, send.installId))).toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
