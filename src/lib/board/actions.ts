"use server";

import { redirect } from "next/navigation";
import { ZodError, z } from "zod";
import { requireOrg } from "@/lib/auth";
import {
  deleteProviderKey,
  storeProviderKey,
} from "@/lib/services/keys";
import { createAgent, createRoutine } from "@/lib/board/mutations";

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
  await createAgent({
    ...values,
    orgId: session.orgId,
    actorId: session.userId,
  });

  redirect("/agents?status=created");
}

export async function createRoutineAction(formData: FormData) {
  const session = await requireOrg();
  const values = parseFormData(createRoutineSchema, formData, "/routines");

  try {
    await createRoutine({
      orgId: session.orgId,
      actorId: session.userId,
      name: values.name,
      description: values.description,
      agentId: values.agentId,
      cronExpression: values.cron,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Agent not found") {
      redirect("/routines?error=Select%20a%20valid%20agent");
    }

    throw error;
  }

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
