import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-full items-center justify-center">
      <SignUp />
    </div>
  );
}
