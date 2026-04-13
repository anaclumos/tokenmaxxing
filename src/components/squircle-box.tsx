"use client";

import { Squircle } from "@squircle-js/react";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

const RADIUS_MAP: Record<string, number> = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
};

interface SquircleBoxProps extends Omit<ComponentProps<"div">, "ref"> {
  radius?: keyof typeof RADIUS_MAP | number;
  smoothing?: number;
}

export function SquircleBox({
  radius = "lg",
  smoothing = 1,
  className,
  children,
  ...props
}: SquircleBoxProps) {
  const r = typeof radius === "number" ? radius : (RADIUS_MAP[radius] ?? 16);

  return (
    <Squircle
      cornerRadius={r}
      cornerSmoothing={smoothing}
      className={cn(className)}
      {...props}
    >
      {children}
    </Squircle>
  );
}
