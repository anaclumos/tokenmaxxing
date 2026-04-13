"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ZodError, z } from "zod";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { activityLog, agents, routineTriggers, routines } from "@/lib/db/schema";
import {
  deleteProviderKey,
  storeProviderKey,
} from "@/lib/services/keys";

const providerSchema = z.enum(["anthropic", "google", "openai"]);

const createAgentSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  shortname: z.string().trim().min(1, "Shortname is required"),
  provider: providerSchema,
  model: z.string().trim().min(1, "Model is required"),
  role: z.string().trim().min(1, "Role is required"),
  title: z.string().trim().min(1, "Title is required"),
  systemPrompt: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  monthlyBudgetCents: z
    .union([z.literal(""), z.coerce.number().int().nonnegative()])
    .optional()
    .transform((value) =>
      value === "" || value === undefined ? undefined : value,
    ),
});

const createRoutineSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  description: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  agentId: z.string().uuid("Select a valid agent"),
  cron: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
});

const saveProviderKeySchema = z.object({
  provider: providerSchema,
  apiKey: z.string().trim().min(1, "API key is required"),
});

const deleteProviderKeySchema = z.object({
  provider: providerSchema,
});

function parseFormData<T>(
  schema: z.ZodType<T>,
  formData: FormData,
  path: string,
): T {
  try {
    return schema.parse(Object.fromEntries(formData));
  } catch (error) {
    if (error instanceof ZodError) {
      redirect(
        `${path}?error=${encodeURIComponent(
          error.issues[0]?.message ?? "Invalid form data",
        )}`,
      );
    }

    throw error;
  }
}

export async function createAgentAction(formData: FormData) {
  const session = await requireOrg();
  const values = parseFormData(createAgentSchema, formData, "/agents");
  const db = getDb();

  const [agent] = await db
    .insert(agents)
    .values({
      ...values,
      orgId: session.orgId,
    })
    .returning();

  await db.insert(activityLog).values({
    orgId: session.orgId,
    actorType: "board",
    actorId: session.userId,
    action: "agent.created",
    resourceType: "agent",
    resourceId: agent.id,
    metadata: { name: agent.name },
  });

  redirect("/agents?status=created");
}

export async function createRoutineAction(formData: FormData) {
  const session = await requireOrg();
  const values = parseFormData(createRoutineSchema, formData, "/routines");
  const db = getDb();

  const agent = await db.query.agents.findFirst({
    columns: { id: true },
    where: and(eq(agents.orgId, session.orgId), eq(agents.id, values.agentId)),
  });

  if (!agent) {
    redirect("/routines?error=Select%20a%20valid%20agent");
  }

  const [routine] = await db
    .insert(routines)
    .values({
      orgId: session.orgId,
      name: values.name,
      description: values.description,
      agentId: values.agentId,
    })
    .returning();

  if (values.cron) {
    await db.insert(routineTriggers).values({
      orgId: session.orgId,
      routineId: routine.id,
      cronExpression: values.cron,
      variables: null,
    });
  }

  await db.insert(activityLog).values({
    orgId: session.orgId,
    actorType: "board",
    actorId: session.userId,
    action: "routine.created",
    resourceType: "routine",
    resourceId: routine.id,
    metadata: { name: routine.name },
  });

  redirect("/routines?status=created");
}

export async function saveProviderKeyAction(formData: FormData) {
  const session = await requireOrg();
  const values = parseFormData(
    saveProviderKeySchema,
    formData,
    "/settings/keys",
  );

  await storeProviderKey(
    session.orgId,
    values.provider,
    values.apiKey,
    session.userId,
  );

  redirect(`/settings/keys?status=saved&provider=${values.provider}`);
}

export async function removeProviderKeyAction(formData: FormData) {
  const session = await requireOrg();
  const values = parseFormData(
    deleteProviderKeySchema,
    formData,
    "/settings/keys",
  );

  await deleteProviderKey(session.orgId, values.provider);

  redirect(`/settings/keys?status=removed&provider=${values.provider}`);
}
