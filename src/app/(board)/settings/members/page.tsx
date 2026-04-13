import { OrganizationProfile } from "@clerk/nextjs";
import { MockOrgProfile } from "@/components/clerk-stubs";

const BYPASS = process.env.BYPASS_AUTH === "true";

export default function MembersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Members
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Manage who has access to this organization.
        </p>
      </div>

      {BYPASS ? (
        <MockOrgProfile />
      ) : (
        <OrganizationProfile
          appearance={{
            elements: {
              rootBox: "w-full",
              cardBox: "w-full shadow-none",
            },
          }}
        />
      )}
    </div>
  );
}
