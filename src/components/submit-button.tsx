"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "@/components/ui/button";

type SubmitButtonProps = ButtonProps & {
  pendingText: string;
};

export function SubmitButton({
  children,
  disabled,
  pendingText,
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button disabled={pending || disabled} {...props}>
      {pending ? pendingText : children}
    </Button>
  );
}
