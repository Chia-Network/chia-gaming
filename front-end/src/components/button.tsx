//v3

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { memo } from 'react';

// Spinner component with smooth appearance animation
const Spinner = () => (
  <svg
    className='h-4 w-4 animate-spin'
    xmlns='http://www.w3.org/2000/svg'
    fill='none'
    viewBox='0 0 24 24'
  >
    <circle
      className='opacity-25'
      cx='12'
      cy='12'
      r='10'
      stroke='currentColor'
      strokeWidth='4'
    ></circle>
    <path
      className='opacity-75'
      fill='currentColor'
      d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
    ></path>
  </svg>
);

const buttonVariants = cva(
  'items-center justify-center rounded-lg font-bold transition-all duration-300 ease-out disabled:opacity-50 hover:cursor-pointer disabled:cursor-not-allowed leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 select-none hover:shadow-[0_1px_3px_0_rgb(0,0,0,0.1),0_1px_2px_-1px_rgb(0,0,0,0.1)]',
  {
    variants: {
      color: {
        primary: '',
        neutral: '',
        secondary: '',
        outline: '',
        ghost: '',
        link: '',
      },
      variant: {
        solid: '',
        soft: '',
        surface: '',
        outline: '',
        ghost: '',
        destructive:
          'bg-alert-solid text-alert-on-alert hover:bg-alert-solid-hover',
      },
      size: {
        sm: 'px-5 h-8 text-sm',
        default: 'px-6 h-10 text-base',
        lg: 'px-8 h-14 text-lg',
      },
      isIcon: {
        true: '',
        false: '',
      },
      isLoading: {
        true: '',
        false: '',
      },
      fullWidth: {
        false: 'inline-flex w-fit',
        true: 'flex w-full',
      },
    },
    compoundVariants: [
      // Primary variants
      {
        color: 'primary',
        variant: 'solid',
        class:
          'bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover active:bg-primary-solid-hover/90',
      },
      {
        color: 'primary',
        variant: 'soft',
        class:
          'bg-primary-bg-hover text-primary-text-contrast hover:bg-primary-bg-active active:bg-primary-line',
      },
      {
        color: 'primary',
        variant: 'surface',
        class:
          'border border-primary-border bg-primary-bg-subtle text-primary-text-contrast hover:bg-primary-bg hover:border-primary-border-hover active:bg-primary-bg-hover',
      },
      {
        color: 'primary',
        variant: 'outline',
        class:
          'border border-primary-border text-primary-text-contrast hover:border-primary-border-hover',
      },
      {
        color: 'primary',
        variant: 'ghost',
        class:
          'bg-transparent text-primary-text hover:bg-primary-bg-hover active:bg-primary-bg-active',
      },
      {
        color: 'primary',
        variant: 'destructive',
        class: 'bg-alert-solid text-alert-on-alert hover:bg-alert-solid-hover',
      },

      // Neutral variants
      {
        color: 'neutral',
        variant: 'solid',
        class:
          'bg-canvas-text-contrast text-canvas-on-canvas hover:bg-canvas-text-contrast/90 active:bg-canvas-text-contrast/80',
      },
      {
        color: 'neutral',
        variant: 'soft',
        class:
          'bg-canvas-bg-hover text-canvas-text hover:bg-canvas-bg-active active:bg-canvas-line',
      },
      {
        color: 'neutral',
        variant: 'surface',
        class:
          'border border-canvas-border bg-canvas-bg text-canvas-text hover:bg-canvas-bg-hover hover:border-canvas-border-hover active:bg-canvas-bg-active',
      },
      {
        color: 'neutral',
        variant: 'outline',
        class:
          'border border-canvas-border text-canvas-text hover:border-canvas-border-hover',
      },
      {
        color: 'neutral',
        variant: 'ghost',
        class:
          'bg-transparent text-canvas-text hover:bg-canvas-bg-hover active:bg-canvas-bg-active',
      },
      {
        color: 'neutral',
        variant: 'destructive',
        class: 'bg-alert-solid text-alert-on-alert hover:bg-alert-solid-hover',
      },

      // Secondary variants
      {
        color: 'secondary',
        variant: 'solid',
        class:
          'bg-secondary-solid text-secondary-on-secondary hover:bg-secondary-solid-hover active:bg-secondary-solid-hover/90',
      },
      {
        color: 'secondary',
        variant: 'soft',
        class:
          'bg-secondary-bg-hover text-secondary-text hover:bg-secondary-bg-active active:bg-secondary-line',
      },
      {
        color: 'secondary',
        variant: 'surface',
        class:
          'border border-secondary-border bg-secondary-bg-subtle text-secondary-text hover:bg-secondary-bg hover:border-secondary-border-hover active:bg-secondary-bg-hover',
      },
      {
        color: 'secondary',
        variant: 'outline',
        class:
          'border border-secondary-border text-secondary-text hover:border-secondary-border-hover',
      },
      {
        color: 'secondary',
        variant: 'ghost',
        class:
          'bg-transparent text-secondary-text hover:bg-secondary-bg-hover active:bg-secondary-bg-active',
      },
      {
        color: 'secondary',
        variant: 'destructive',
        class: 'bg-alert-solid text-alert-on-alert hover:bg-alert-solid-hover',
      },

      // Link variants
      {
        color: 'link',
        variant: 'solid',
        class:
          'text-primary-solid hover:text-primary-solid-hover bg-transparent',
      },
      {
        color: 'link',
        variant: 'ghost',
        class:
          'text-primary-solid hover:text-primary-solid-hover bg-transparent',
      },

      // Icon buttons
      {
        isIcon: true,
        size: 'sm',
        class: '!px-0 !w-8 !max-w-8 hover:!shadow-none',
      },
      {
        isIcon: true,
        size: 'default',
        class: '!px-0 !w-10 !max-w-10 hover:!shadow-none',
      },
      {
        isIcon: true,
        size: 'lg',
        class: '!px-0 !w-14 !max-w-14 hover:!shadow-none',
      },

      // Loading
      {
        isLoading: true,
        class: 'relative !cursor-wait',
      },

      // Focus ring
      { color: 'primary', class: 'focus-visible:ring-primary-solid' },
      { color: 'neutral', class: 'focus-visible:ring-canvas-solid' },
      { color: 'secondary', class: 'focus-visible:ring-secondary-solid' },
      { color: 'link', class: 'focus-visible:ring-primary-solid' },
    ],
    defaultVariants: {
      color: 'primary',
      variant: 'solid',
      size: 'default',
      isIcon: false,
      isLoading: false,
      fullWidth: false,
    },
  },
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  leadingIcon?: React.ReactElement;
  trailingIcon?: React.ReactElement;
  iconOnly?: boolean; // set for icon buttons
  isLoading?: boolean; // new loading state prop
  loadingText?: string; // optional loading text
  fullWidth?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      color,
      variant,
      size,
      asChild = false,
      leadingIcon,
      trailingIcon,
      iconOnly = false,
      isLoading = false,
      loadingText,
      className,
      children,
      disabled,
      fullWidth = false,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';

    // If iconOnly is true, we only render the leadingIcon
    const icon = iconOnly ? leadingIcon : null;

    // Determine if button should be disabled (when loading or explicitly disabled)
    const isDisabled = isLoading || disabled;

    return (
      <Comp
        ref={ref}
        type='button'
        className={buttonVariants({
          color,
          variant,
          size,
          isIcon: iconOnly,
          isLoading,
          fullWidth,
          className,
        })}
        disabled={isDisabled}
        {...props}
      >
        {/* Loading State */}
        {isLoading && iconOnly && <Spinner />}

        {/* Loading State with Text */}
        {isLoading && !iconOnly && (
          <>
            <span className='mr-2'>
              <Spinner />
            </span>
            {loadingText || children}
          </>
        )}

        {/* Normal Icon Only */}
        {!isLoading && iconOnly && icon}

        {/* Normal Button with Text */}
        {!isLoading && !iconOnly && (
          <>
            {leadingIcon && <span className='mr-2'>{leadingIcon}</span>}
            {children}
            {trailingIcon && <span className='ml-2'>{trailingIcon}</span>}
          </>
        )}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

// export default Button;

const ButtonMemoized = memo(Button);
export { buttonVariants };
export { ButtonMemoized as Button };
