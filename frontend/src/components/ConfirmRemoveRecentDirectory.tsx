import ConfirmModal from "./ConfirmModal";

interface ConfirmRemoveRecentDirectoryProps {
  /** The folder awaiting confirmation; `null` keeps the dialog closed. */
  path: string | null;
  onConfirm: (path: string) => void;
  /** Called whenever the dialog closes — after Remove as well as after Cancel. */
  onClose: () => void;
}

/** "Remove this folder from your recent directories?" — shared by every place that lists them. */
export default function ConfirmRemoveRecentDirectory({ path, onConfirm, onClose }: ConfirmRemoveRecentDirectoryProps) {
  return (
    <ConfirmModal
      isOpen={path !== null}
      onClose={onClose}
      onConfirm={() => {
        if (path !== null) onConfirm(path);
      }}
      title="Remove Recent Directory"
      message={`Are you sure you want to remove "${path ?? ""}" from your recent directories? This action cannot be undone.`}
      confirmText="Remove"
      confirmStyle="danger"
    />
  );
}
