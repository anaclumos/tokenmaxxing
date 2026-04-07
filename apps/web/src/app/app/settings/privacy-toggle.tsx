import { BooleanSettingToggle } from "./boolean-setting-toggle";

export function PrivacyToggle({ initial }: { initial: boolean }) {
  return (
    <BooleanSettingToggle
      initial={initial}
      label="Privacy mode"
      onDescription="Your profile, leaderboard entry, badge, and card are hidden."
      offDescription="Your profile and stats are publicly visible."
      endpoint="/api/settings/privacy"
      bodyKey="privacyMode"
    />
  );
}
