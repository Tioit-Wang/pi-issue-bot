import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useResolvedTheme } from "@/layout/use-theme.ts"

/*
 * 官方产物的**必要改动**（唯一一处）：主题来源从 `next-themes` 的 `useTheme()` 换成项目自己的
 * `useResolvedTheme()`。为什么：本项目没有挂 `next-themes` 的 `ThemeProvider`（主题走
 * `layout/use-theme.ts` 的 `data-theme` + `.dark` 双通道），`useTheme()` 永远返回 `undefined`，
 * 于是用户手选深色时提示框仍按系统配色画。这是接线替换，不是改外观。
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useResolvedTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
