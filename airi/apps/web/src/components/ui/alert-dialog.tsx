"use client";

import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

const AlertDialogModeContext = React.createContext(false);

function useAlertDialogMode() {
  return React.useContext(AlertDialogModeContext);
}

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root> &
  React.ComponentProps<typeof Drawer>) {
  const isMobile = useIsMobile();
  return (
    <AlertDialogModeContext.Provider value={isMobile}>
      {isMobile ? (
        <Drawer data-slot="alert-dialog" direction="bottom" {...props} />
      ) : (
        <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
      )}
    </AlertDialogModeContext.Provider>
  );
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger> &
  React.ComponentProps<typeof DrawerTrigger>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return <DrawerTrigger data-slot="alert-dialog-trigger" {...props} />;
  }
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  );
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal> &
  React.ComponentProps<typeof DrawerPortal>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return <DrawerPortal data-slot="alert-dialog-portal" {...props} />;
  }
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  );
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay> &
  React.ComponentProps<typeof DrawerOverlay>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return (
      <DrawerOverlay
        data-slot="alert-dialog-overlay"
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
          className
        )}
        {...props}
      />
    );
  }
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  onOpenAutoFocus,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> &
  React.ComponentProps<typeof DrawerContent>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return (
      <DrawerContent
        data-slot="alert-dialog-content"
        className={cn("gap-4 p-6", className)}
        {...props}
        role="alertdialog"
        onOpenAutoFocus={event => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;

          const cancel = (
            event.currentTarget as HTMLElement
          ).querySelector<HTMLButtonElement>(
            '[data-slot="alert-dialog-cancel"]'
          );
          if (!cancel) return;

          event.preventDefault();
          cancel.focus({ preventScroll: true });
        }}
      />
    );
  }
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className
        )}
        {...props}
        onOpenAutoFocus={onOpenAutoFocus}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return (
      <DrawerHeader
        data-slot="alert-dialog-header"
        className={cn(
          "flex flex-col gap-2 text-center sm:text-left",
          className
        )}
        {...props}
      />
    );
  }
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return (
      <DrawerFooter
        data-slot="alert-dialog-footer"
        className={cn(
          "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
          className
        )}
        {...props}
      />
    );
  }
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title> &
  React.ComponentProps<typeof DrawerTitle>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return (
      <DrawerTitle
        data-slot="alert-dialog-title"
        className={cn("text-lg font-semibold", className)}
        {...props}
      />
    );
  }
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg font-semibold", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description> &
  React.ComponentProps<typeof DrawerDescription>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    return (
      <DrawerDescription
        data-slot="alert-dialog-description"
        className={cn("text-muted-foreground text-sm", className)}
        {...props}
      />
    );
  }
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    const actionProps = { ...props };
    delete actionProps.asChild;
    const { type, ...buttonProps } = actionProps;
    return (
      <DrawerClose asChild>
        <button
          type={type ?? "button"}
          className={cn(buttonVariants(), className)}
          {...buttonProps}
        />
      </DrawerClose>
    );
  }
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonVariants(), className)}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  const isMobile = useAlertDialogMode();
  if (isMobile) {
    const actionProps = { ...props };
    delete actionProps.asChild;
    const { type, ...buttonProps } = actionProps;
    return (
      <DrawerClose asChild>
        <button
          type={type ?? "button"}
          className={cn(buttonVariants({ variant: "outline" }), className)}
          {...buttonProps}
          data-slot="alert-dialog-cancel"
        />
      </DrawerClose>
    );
  }
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
      data-slot="alert-dialog-cancel"
    />
  );
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
