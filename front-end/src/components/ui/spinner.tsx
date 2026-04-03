import * as React from "react"
import { cn } from "../../lib/utils"

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: number
}

export function Spinner({ size = 24, className, ...props }: SpinnerProps) {
  return (
    <div
      role="status"
      aria-label="loading"
      className={cn(
        "animate-spin rounded-full border-2 border-muted border-t-primary",
        className
      )}
      style={{
        width: size,
        height: size,
        ...props.style,
      }}
      {...props}
    />
  )
}
