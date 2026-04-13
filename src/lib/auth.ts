const BYPASS = process.env.BYPASS_AUTH === "true";

const MOCK_SESSION = {
  userId: "user_test",
  orgId: "org_test",
  orgRole: "org:admin" as string,
};

async function getSession() {
  if (BYPASS) return MOCK_SESSION;

  const { auth } = await import("@clerk/nextjs/server");
  const { userId, orgId, orgRole } = await auth();

  if (!userId || !orgId || !orgRole) {
    throw new Error("Organization membership required");
  }

  return { userId, orgId, orgRole };
}

export async function requireOrg() {
  return getSession();
}

export async function requireOrgAdmin() {
  const session = await getSession();

  if (session.orgRole !== "org:admin") {
    throw new Error("Organization admin role required");
  }

  return session;
}

export async function validateOrgAccess(pathOrgId: string) {
  const session = await getSession();

  if (session.orgId !== pathOrgId) {
    throw new Error("Organization access denied");
  }

  return session;
}
