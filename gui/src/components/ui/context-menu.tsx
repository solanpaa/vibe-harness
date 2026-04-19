import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

interface ContextMenuProps {
  children: React.ReactNode
}

interface ContextMenuContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  anchorRef: React.MutableRefObject<VirtualAnchor | null>
}

class VirtualAnchor {
  x: number
  y: number

  constructor(x: number, y: number) {
    this.x = x
    this.y = y
  }

  getBoundingClientRect() {
    return {
      x: this.x,
      y: this.y,
      width: 0,
      height: 0,
      top: this.y,
      right: this.x,
      bottom: this.y,
      left: this.x,
      toJSON: () => {},
    }
  }
}

const ContextMenuContext = React.createContext<ContextMenuContextValue | null>(null)

function useContextMenu() {
  const ctx = React.useContext(ContextMenuContext)
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenu")
  return ctx
}

function ContextMenu({ children }: ContextMenuProps) {
  const [open, setOpen] = React.useState(false)
  const anchorRef = React.useRef<VirtualAnchor | null>(null)

  return (
    <ContextMenuContext.Provider value={{ open, setOpen, anchorRef }}>
      <MenuPrimitive.Root open={open} onOpenChange={setOpen}>
        {children}
      </MenuPrimitive.Root>
    </ContextMenuContext.Provider>
  )
}

function ContextMenuTrigger({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const { setOpen, anchorRef } = useContextMenu()

  const handleContextMenu = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      anchorRef.current = new VirtualAnchor(e.clientX, e.clientY)
      setOpen(true)
    },
    [setOpen, anchorRef],
  )

  return (
    <div
      data-slot="context-menu-trigger"
      onContextMenu={handleContextMenu}
      className={className}
      {...props}
    >
      {children}
    </div>
  )
}

function ContextMenuContent({
  className,
  ...props
}: MenuPrimitive.Popup.Props) {
  const { anchorRef } = useContextMenu()

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        anchor={anchorRef.current ?? undefined}
        side="bottom"
        align="start"
        sideOffset={0}
        alignOffset={0}
      >
        <MenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "z-50 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  variant?: "default" | "destructive"
}) {
  return (
    <MenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
}
