import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot, Slottable } from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

const PUSH_VARIANTS = ["default", "destructive"] as const;

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    fullWidth?: boolean;
  };

const pushButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "btn-push btn-push-default",
        destructive: "btn-push btn-push-destructive",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "",
        xs: "btn-push-sm",
        sm: "btn-push-sm",
        lg: "btn-push-lg",
        icon: "btn-push-icon",
        "icon-xs": "btn-push-icon-sm",
        "icon-sm": "btn-push-icon",
        "icon-lg": "btn-push-icon-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

/** Exported for use on non-Button elements (e.g. AlertDialog, Pagination). Uses flat styles. */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  fullWidth = false,
  style,
  ...props
}: ButtonProps) {
  const isPush =
    variant &&
    PUSH_VARIANTS.includes(variant as (typeof PUSH_VARIANTS)[number]);
  const flatWidthClassName = fullWidth ? "flex w-full" : undefined;
  const pushWidthClassName = fullWidth ? "w-full" : undefined;
  const flatWidthStyle = fullWidth
    ? {
        ...style,
        display: "flex",
        width: "100%",
      }
    : style;
  const pushWidthStyle = fullWidth
    ? {
        ...style,
        width: "100%",
      }
    : style;

  if (asChild) {
    const Comp = Slot;

    if (isPush) {
      const child = React.Children.only(props.children);

      if (!React.isValidElement(child)) {
        return null;
      }

      const childElement = child as React.ReactElement<{
        className?: string;
        children?: React.ReactNode;
        style?: React.CSSProperties;
        [key: string]: unknown;
      }>;
      const childProps = childElement.props;
      const childStyle = childProps.style;

      return React.cloneElement(
        childElement,
        {
          ...props,
          className: cn(
            pushButtonVariants({ variant, size }),
            pushWidthClassName,
            className,
            childProps.className
          ),
          style: fullWidth
            ? {
                ...childStyle,
                ...style,
                display: "grid",
                width: "100%",
              }
            : {
                ...childStyle,
                ...style,
              },
          "data-slot": "button",
          "data-variant": variant,
          "data-size": size,
          "data-full-width": fullWidth ? "true" : undefined,
        },
        <>
          <span className="btn-push-shadow" aria-hidden />
          <span className="btn-push-edge" aria-hidden />
          <span className="btn-push-front">{childProps.children}</span>
        </>
      );
    }

    return (
      <Comp
        data-slot="button"
        data-variant={variant}
        data-size={size}
        data-full-width={fullWidth ? "true" : undefined}
        className={cn(
          buttonVariants({ variant, size }),
          flatWidthClassName,
          className
        )}
        style={flatWidthStyle}
        {...props}
      >
        <Slottable>{props.children}</Slottable>
      </Comp>
    );
  }

  if (isPush) {
    return (
      <button
        data-slot="button"
        data-variant={variant}
        data-size={size}
        data-full-width={fullWidth ? "true" : undefined}
        type="button"
        className={cn(
          pushButtonVariants({ variant, size }),
          pushWidthClassName,
          className
        )}
        style={pushWidthStyle}
        {...props}
      >
        <span className="btn-push-shadow" aria-hidden />
        <span className="btn-push-edge" aria-hidden />
        <span className="btn-push-front">
          <Slottable>{props.children}</Slottable>
        </span>
      </button>
    );
  }

  const Comp = "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth ? "true" : undefined}
      type="button"
      className={cn(
        buttonVariants({ variant, size }),
        flatWidthClassName,
        className
      )}
      style={flatWidthStyle}
      {...props}
    >
      <Slottable>{props.children}</Slottable>
    </Comp>
  );
}

export { Button, buttonVariants };
