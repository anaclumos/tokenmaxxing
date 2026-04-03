# v2 Website Design

## Overview

Migrate tokenmaxx.ing to a two-zone architecture using Tremor templates:
- **Marketing zone** (`/`, `/leaderboard`, `/u/[username]`): adapted from template-solar
- **App zone** (`/app/*`): adapted from template-planner with sidebar layout

## Routing

```
(marketing)/
  page.tsx                    -- landing page (solar template)
  leaderboard/page.tsx        -- public leaderboard (current home)
  u/[username]/page.tsx       -- public profiles
  layout.tsx                  -- Navbar + Footer, no sidebar

(auth)/
  sign-in/[[...sign-in]]/     -- Clerk (unchanged)
  sign-up/[[...sign-up]]/     -- Clerk (unchanged)

(app)/
  layout.tsx                  -- sidebar + header + breadcrumbs
  page.tsx                    -- dashboard (current /dashboard)
  settings/page.tsx           -- privacy + API tokens
  docs/page.tsx               -- API docs
  orgs/create/page.tsx
  orgs/[orgSlug]/
    leaderboard/page.tsx
    analytics/page.tsx
```

API routes remain unchanged at `/api/*`.

## Landing page sections (adapted from solar)

1. **Hero**: "tokenmaxx.ing" headline, tagline about competitive token usage tracking, CTA to sign up / view leaderboard. Game of Life background animation.
2. **Features**: 3 blocks -- Track (submit usage from 14+ AI agents), Compete (leaderboard with composite scoring), Analyze (dashboard with heatmaps, cost trends, cache efficiency).
3. **Testimonial**: Community quote or stats highlight (e.g. "X tokens tracked across Y users").
4. **Analytics showcase**: Preview of the dashboard/leaderboard with tilted table illustration.
5. **CTA**: "Ready to start tracking?" with sign-up button.
6. **Footer**: Links to GitHub, docs, leaderboard. Social links.

## App layout (adapted from planner)

- **Sidebar**: Collapsible, cookie-persisted state. Sections:
  - Dashboard (home icon)
  - Leaderboard (external link to /leaderboard)
  - Settings
  - Docs
  - Orgs (collapsible group with org list)
- **Header**: Breadcrumbs + UserProfile dropdown (Clerk user button)
- **Mobile**: Sidebar becomes a drawer

## Theme

- Add `next-themes` with `ThemeProvider` (system/light/dark)
- Convert current dark-only OKLch CSS vars to support both modes using `@custom-variant dark`
- Landing page: neutral grays + accent color (keep current teal-cyan or shift to match branding)
- App: same palette, sidebar uses darker shade in dark mode

## Typography

- Keep SunghyunSans (sans) and Iosevka (mono) -- no Geist
- All solar/planner references to Geist replaced with SunghyunSans

## New dependencies

- `next-themes` -- theme toggle
- `recharts` -- charts in app dashboard
- `motion` -- landing page animations
- `@remixicon/react` -- icon set

## Component organization

```
apps/web/src/components/
  marketing/          -- solar-derived components
    Hero.tsx
    HeroBackground.tsx
    Features.tsx
    Testimonial.tsx
    AnalyticsShowcase.tsx
    CallToAction.tsx
    MarketingNavbar.tsx
    MarketingFooter.tsx
    Fade.tsx
    Orbit.tsx
  app/                -- planner-derived layout components
    AppSidebar.tsx
    AppHeader.tsx
    Breadcrumbs.tsx
    UserProfile.tsx
    ThemeToggle.tsx
```

Existing components in `packages/ui/` stay. New shared components (if any) go there.

## Migration of existing pages

| Current path | New path | Changes |
|---|---|---|
| `(main)/page.tsx` | `(marketing)/leaderboard/page.tsx` | Wrapped in marketing layout |
| `(main)/dashboard/` | `(app)/page.tsx` | Wrapped in app sidebar layout |
| `(main)/settings/` | `(app)/settings/` | Wrapped in app sidebar layout |
| `(main)/docs/` | `(app)/docs/` | Wrapped in app sidebar layout |
| `(main)/u/[username]/` | `(marketing)/u/[username]/` | Wrapped in marketing layout |
| `(main)/orgs/` | `(app)/orgs/` | Wrapped in app sidebar layout |
| `(main)/layout.tsx` | Deleted, replaced by two new layouts |

## What stays unchanged

- All API routes (`/api/*`)
- `packages/db`, `packages/shared`, `packages/ui`
- `apps/cli`
- Clerk auth config, webhooks
- Database schema
- Vercel cron jobs
- All existing page logic/queries -- only the layout wrappers change

## Tailwind v4 adaptation

Both templates must be converted to Tailwind v4 CSS-based config (no `tailwind.config.ts`). The planner template uses v3 -- its custom colors, keyframes, and theme extensions move into `globals.css` `@theme` blocks.
