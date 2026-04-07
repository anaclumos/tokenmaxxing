import { BooleanSettingToggle } from "./boolean-setting-toggle";

export function WeeklyDigestToggle({ initial }: { initial: boolean }) {
  return (
    <BooleanSettingToggle
      initial={initial}
      label="Weekly digest"
      onDescription="You'll get a Monday summary email with tokens, cost, streak, and rank movement."
      offDescription="Turn on a Monday summary email with your weekly token usage highlights."
      endpoint="/api/settings/weekly-digest"
      bodyKey="weeklyDigestEnabled"
    />
  );
}
