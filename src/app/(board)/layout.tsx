"use client";

import dynamic from "next/dynamic";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  MockOrgSwitcher,
  MockUserButton,
} from "@/components/clerk-stubs";
import Link from "next/link";
import { usePathname } from "next/navigation";

const BYPASS = process.env.NEXT_PUBLIC_BYPASS_AUTH === "true";

const ClerkOrganizationSwitcher = BYPASS
  ? MockOrgSwitcher
  : dynamic(
      () =>
        import("@clerk/nextjs").then((mod) => mod.OrganizationSwitcher),
      { ssr: false, loading: () => <MockOrgSwitcher /> },
    );

const ClerkUserButton = BYPASS
  ? MockUserButton
  : dynamic(
      () => import("@clerk/nextjs").then((mod) => mod.UserButton),
      { ssr: false, loading: () => <MockUserButton /> },
    );

const navItems = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Agents", href: "/agents" },
  { label: "Issues", href: "/issues" },
  { label: "Goals", href: "/goals" },
  { label: "Projects", href: "/projects" },
  { label: "Routines", href: "/routines" },
  { label: "Approvals", href: "/approvals" },
  { label: "Costs", href: "/costs" },
  { label: "Org Chart", href: "/org-chart" },
  { label: "Activity", href: "/activity" },
];

const configItems = [
  { label: "Settings", href: "/settings" },
  { label: "API Keys", href: "/settings/keys" },
  { label: "Members", href: "/settings/members" },
  { label: "Budgets", href: "/settings/budgets" },
  { label: "Integrations", href: "/integrations" },
  { label: "Skills", href: "/skills" },
  { label: "Plugins", href: "/plugins" },
];

export default function BoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  const currentLabel =
    navItems.find((n) => pathname.startsWith(n.href))?.label ??
    configItems.find((n) => pathname.startsWith(n.href))?.label ??
    "Tokenmaxxing";

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="p-4">
          <p className="text-sm font-semibold tracking-tight">Tokenmaxxing</p>
          <div className="mt-3">
            <ClerkOrganizationSwitcher />
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {navItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.href}
                    >
                      <Link href={item.href}>{item.label}</Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup>
            <SidebarGroupLabel>Configuration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {configItems.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.href}
                    >
                      <Link href={item.href}>{item.label}</Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-4">
          <ClerkUserButton />
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b border-border/50 px-6">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <p className="text-sm text-muted-foreground">{currentLabel}</p>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
