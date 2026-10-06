# Host

Traps in the timer, the hub service, and the pool lock on a running host.

- Find the pool-lock holder on Linux with `ino=$(stat -c %i <state dir>/lock); grep -F ":$ino " /proc/locks` (the PID is the fifth field), then `ps -o pid,ppid,etime,comm -p <pid>`. A managed `claude` launch, its exit, and a plain `status` (no `--cached`) wait on that flock, so a wrapper that prints nothing for a long time points at lock starvation; `ls -l /proc/<pid>/fd` of the waiting process shows what it holds.
- The check timer uses only `OnBootSec` and `OnUnitActiveSec` (`src/lib/install.ts`, both Nix modules); never add `Persistent=`, which systemd reads only for `OnCalendar=` timers, so a missed tick is never caught up and a leftover `stamp-tokenmaxxing-check.timer` file is harmless.
- The self-update and a manual `bun add -g` replace the installed files but never restart the hub, so `tokenmaxxing-hub.service` (or the `com.tokenmaxxing.hub` launchd agent) serves the old code until it restarts; after an update run `systemctl --user try-restart tokenmaxxing-hub.service` on Linux or restart the launchd agent on macOS.
