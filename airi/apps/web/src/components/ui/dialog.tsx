"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
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

const DialogModeContext = React.createContext(false);

function useDialogMode() {
  return React.useContext(DialogModeContext);
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> &
  React.ComponentProps<typeof Drawer>) {
  const isMobile = useIsMobile();
  return (
    <DialogModeContext.Provider value={isMobile}>
      {isMobile ? (
        <Drawer data-slot="dialog" direction="bottom" {...props} />
      ) : (
        <DialogPrimitive.Root data-slot="dialog" {...props} />
      )}
    </DialogModeContext.Provider>
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger> &
  React.ComponentProps<typeof DrawerTrigger>) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return <DrawerTrigger data-slot="dialog-trigger" {...props} />;
  }
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal> &
  React.ComponentProps<typeof DrawerPortal>) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return <DrawerPortal data-slot="dialog-portal" {...props} />;
  }
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close> &
  React.ComponentProps<typeof DrawerClose>) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return <DrawerClose data-slot="dialog-close" {...props} />;
  }
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay> &
  React.ComponentProps<typeof DrawerOverlay>) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return (
      <DrawerOverlay
        data-slot="dialog-overlay"
        className={cn(
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
          className
        )}
        {...props}
      />
    );
  }
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  React.ComponentProps<typeof DrawerContent> & {
    showCloseButton?: boolean;
  }) {
  const t = useTranslations("Dialog");
  const isMobile = useDialogMode();

  if (isMobile) {
    return (
      <DrawerContent
        data-slot="dialog-content"
        className={cn("gap-4 p-6", className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DrawerClose
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">{t("close")}</span>
          </DrawerClose>
        )}
      </DrawerContent>
    );
  }

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-150 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">{t("close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return (
      <DrawerHeader
        data-slot="dialog-header"
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
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return (
      <DrawerFooter
        data-slot="dialog-footer"
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
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> &
  React.ComponentProps<typeof DrawerTitle>) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return (
      <DrawerTitle
        data-slot="dialog-title"
        className={cn("text-lg leading-none font-semibold", className)}
        {...props}
      />
    );
  }
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description> &
  React.ComponentProps<typeof DrawerDescription>) {
  const isMobile = useDialogMode();
  if (isMobile) {
    return (
      <DrawerDescription
        data-slot="dialog-description"
        className={cn("text-muted-foreground text-sm", className)}
        {...props}
      />
    );
  }
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
