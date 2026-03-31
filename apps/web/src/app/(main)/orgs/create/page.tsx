import { CreateOrganization } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export const metadata = { title: "Create Organization - tokenmaxx.ing" };

export default async function CreateOrgPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <main className="flex flex-1 flex-col items-center justify-center py-12">
      <h1 className="mb-6 text-2xl font-bold">Create a Leaderboard</h1>
      <p className="mb-8 max-w-md text-center text-muted-foreground">
        Organizations are private leaderboards. Invite your team and compete.
      </p>
      <CreateOrganization afterCreateOrganizationUrl="/dashboard" />
    </main>
  );
}
