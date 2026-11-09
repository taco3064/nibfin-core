import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui Button, bounded to the native button and the shared semantic palette.
const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md border border-input ' +
  'px-4 py-2 text-base font-medium bg-primary text-primary-foreground ' +
  'focus-visible:outline focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed',
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>
  & VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, type = 'button', ...props }, ref) => (
    <button type={type} className={cn(buttonVariants(), className)}
      ref={ref} {...props} />
  ),
);
Button.displayName = 'Button';
