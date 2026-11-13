import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex max-w-full items-center justify-center gap-2 rounded-md " +
  "text-sm font-medium transition-colors " +
  "focus-visible:outline focus-visible:outline-ring " +
  "disabled:cursor-not-allowed " +
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-solid border-input bg-primary text-primary-foreground shadow",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background text-foreground shadow-sm " +
          "hover:bg-muted hover:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const classes = cn(buttonVariants({ variant, size, className }))
    if (asChild) {
      const slotProps = props as React.ComponentPropsWithoutRef<typeof Slot>
      return <Slot className={classes} ref={ref} {...slotProps} />
    }
    return <button className={classes} ref={ref} {...props} />
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }

export function ButtonLink({ href, label, variant }: {
  href: string
  label: string
  variant: "default" | "outline"
}) {
  return (
    <Button
      asChild
      size="lg"
      className="h-auto min-h-11 whitespace-normal border-solid px-4"
      variant={variant}
    >
      <a href={href}>{label}</a>
    </Button>
  )
}
