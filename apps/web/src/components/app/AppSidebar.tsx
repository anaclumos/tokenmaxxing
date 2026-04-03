"use client"

import { UserButton } from "@clerk/nextjs"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarLink,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/app/Sidebar"
import { ThemeToggle } from "@/components/app/ThemeToggle"
import { BarChart3, BookText, House, Settings, Trophy } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ComponentProps } from "react"

export function AppSidebar(props: ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()

  const navigation = [
    { name: "Dashboard", href: "/app", icon: House },
    { name: "Leaderboard", href: "/leaderboard", icon: Trophy },
    { name: "Settings", href: "/app/settings", icon: Settings },
    { name: "Docs", href: "/app/docs", icon: BookText },
  ]

  return (
    <Sidebar {...props} className="bg-gray-50 dark:bg-gray-950">
      <SidebarHeader className="px-3 py-4">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-white p-1.5 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-800">
            <BarChart3 className="size-5 text-primary" />
          </span>
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-50">
            tokenmaxx.ing
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {navigation.map((item) => (
                <SidebarMenuItem key={item.name}>
                  <SidebarLink
                    href={item.href}
                    isActive={pathname === item.href || (item.href !== "/app" && pathname.startsWith(item.href))}
                    icon={item.icon}
                  >
                    {item.name}
                  </SidebarLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="border-t border-gray-200 dark:border-gray-800" />
        <div className="flex items-center justify-between p-2">
          <UserButton />
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
