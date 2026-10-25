import { useEffect, useRef, type ReactNode } from "react";
export default function WorkspaceDialog({
  label,
  children,
  onClose,
  className = "workspace-import",
}: {
  label: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const focus = document.activeElement as HTMLElement;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (focus?.isConnected) focus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={className}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
    >
      {children}
    </dialog>
  );
}
