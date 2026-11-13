import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md border ' +
  'border-solid px-4 py-2 text-base font-medium no-underline ' +
  'focus-visible:outline focus-visible:outline-ring disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'border-input bg-primary text-primary-foreground',
        outline: 'border-border text-foreground hover:bg-muted',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>
  & VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, type = 'button', variant, ...props }, ref) => (
    <button type={type} className={cn(buttonVariants({ variant }), className)}
      ref={ref} {...props} />
  ),
);
Button.displayName = 'Button';

type ButtonLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement>
  & VariantProps<typeof buttonVariants> & { href: string };

export function ButtonLink({ className, variant, ...props }: ButtonLinkProps) {
  return <a className={cn(buttonVariants({ variant }), className)} {...props} />;
}
