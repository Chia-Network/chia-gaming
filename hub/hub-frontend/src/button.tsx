import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { memo } from 'react';

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
      },
      variant: {
        solid: '',
        outline: '',
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
      {
        color: 'primary',
        variant: 'solid',
        class:
          'bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover active:bg-primary-solid-hover/90',
      },
      {
        color: 'primary',
        variant: 'outline',
        class:
          'border border-primary-border text-primary-text-contrast hover:border-primary-border-hover',
      },
      {
        color: 'neutral',
        variant: 'solid',
        class:
          'bg-canvas-text-contrast text-canvas-on-canvas hover:bg-canvas-text-contrast/90 active:bg-canvas-text-contrast/80',
      },
      {
        color: 'neutral',
        variant: 'outline',
        class:
          'border border-canvas-border text-canvas-text hover:border-canvas-border-hover',
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
  iconOnly?: boolean;
  isLoading?: boolean;
  loadingText?: string;
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
    const icon = iconOnly ? leadingIcon : null;
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
        {isLoading && iconOnly && <Spinner />}

        {isLoading && !iconOnly && (
          <>
            <span className='mr-2'>
              <Spinner />
            </span>
            {loadingText || children}
          </>
        )}

        {!isLoading && iconOnly && icon}

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

const ButtonMemoized = memo(Button);
export { buttonVariants };
export { ButtonMemoized as Button };
