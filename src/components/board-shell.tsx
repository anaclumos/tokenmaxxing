"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import {
  MockOrgSwitcher,
  MockUserButton,
} from "@/components/clerk-stubs";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const navItems = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Agents", href: "/agents" },
  { label: "Org Chart", href: "/org-chart" },
  { label: "Routines", href: "/routines" },
  { label: "Costs", href: "/costs" },
  { label: "Activity", href: "/activity" },
];

const configItems = [
  { label: "API Keys", href: "/settings/keys" },
  { label: "Members", href: "/settings/members" },
  { label: "Budgets", href: "/settings/budgets" },
  { label: "Integrations", href: "/integrations" },
  { label: "Settings", href: "/settings" },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BoardShell({
  bypass,
  children,
}: {
  bypass: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const currentLabel =
    navItems.find((item) => isActive(pathname, item.href))?.label ??
    configItems.find((item) => isActive(pathname, item.href))?.label ??
    "Tokenmaxxing";

  const OrgSwitcher = bypass ? MockOrgSwitcher : OrganizationSwitcher;
  const AccountButton = bypass ? MockUserButton : UserButton;

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="p-4">
          <p className="text-sm font-semibold tracking-tight">Tokenmaxxing</p>
          <div className="mt-3">
            <OrgSwitcher />
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
                      isActive={isActive(pathname, item.href)}
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
                      isActive={isActive(pathname, item.href)}
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
          <AccountButton />
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
