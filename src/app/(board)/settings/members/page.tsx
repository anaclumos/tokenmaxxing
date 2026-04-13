import { OrganizationProfile } from "@clerk/nextjs";

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

      <OrganizationProfile
        appearance={{
          elements: {
            rootBox: "w-full",
            cardBox: "w-full shadow-none",
          },
        }}
      />
    </div>
  );
}
