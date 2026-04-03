"use client";

import { Tabs, TabsList, TabsTrigger } from "@tokenmaxxing/ui/components/tabs";
import { usePathname, useRouter } from "next/navigation";

export function FilterTabs({
  param,
  value,
  options,
}: {
  param: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Tabs
      value={value}
      onValueChange={(v) => router.push(`${pathname}?${param}=${v}`)}
      className="mb-6"
    >
      <TabsList>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value}>
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
