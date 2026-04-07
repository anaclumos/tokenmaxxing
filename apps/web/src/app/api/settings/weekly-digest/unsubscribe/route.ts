import { users } from "@tokenmaxxing/db/index";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { cronEnv } from "@/lib/env";
import { verifyWeeklyDigestUnsubscribeToken } from "@/lib/weekly-digest";

const Query = z.object({
  user: z.string().uuid(),
  token: z.string().length(64),
});

function renderPage({ body, title }: { body: string; title: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        background: #07111f;
        color: #f7fbff;
        font-family: system-ui, sans-serif;
      }
      main {
        max-width: 32rem;
        margin: 0 auto;
        padding: 4rem 1.5rem;
      }
      a {
        color: #8fb8ff;
      }
      .panel {
        background: #10192d;
        border: 1px solid #1d2c45;
        border-radius: 1.5rem;
        padding: 2rem;
      }
      p {
        color: #c4d3ea;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>${title}</h1>
        ${body}
      </div>
    </main>
  </body>
</html>`;
}

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));

  if (!parsed.success) {
    return new Response(
      renderPage({
        title: "Invalid unsubscribe link",
        body: "<p>This weekly digest unsubscribe link is invalid.</p>",
      }),
      {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  const valid = verifyWeeklyDigestUnsubscribeToken({
    secret: cronEnv().CRON_SECRET,
    token: parsed.data.token,
    userId: parsed.data.user,
  });

  if (!valid) {
    return new Response(
      renderPage({
        title: "Invalid unsubscribe link",
        body: "<p>This weekly digest unsubscribe link is invalid.</p>",
      }),
      {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  await db()
    .update(users)
    .set({
      weeklyDigestEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, parsed.data.user));

  return new Response(
    renderPage({
      title: "Weekly digest disabled",
      body: `<p>You will not receive future weekly digest emails from tokenmaxx.ing.</p><p><a href="${new URL("/app/settings", req.url)}">Open settings</a></p>`,
    }),
    {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}
