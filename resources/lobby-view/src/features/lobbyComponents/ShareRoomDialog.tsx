import { Copy } from 'lucide-react';
import React from 'react';

interface ShareRoomDialogProps {
  urlDialogOpen: boolean;
  handleCancelShare: () => void;
  shortenedUrl: string;
  handleCopyAndClose: () => void;
}

const ShareRoomDialog: React.FC<ShareRoomDialogProps> = ({
  urlDialogOpen,
  handleCancelShare,
  shortenedUrl,
  handleCopyAndClose,
}) => {
  if (!urlDialogOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={handleCancelShare}
    >
      <div
        className="bg-canvas-bg text-canvas-text rounded-lg w-full max-w-xs p-4"
        onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside
      >
        {/* Title with close button */}
        <div className="flex justify-between items-center mb-4 pr-1">
          <h2 className="text-lg font-semibold">Room Created 🎉</h2>
          <button
            onClick={handleCancelShare}
            className="p-1 text-canvas-text hover:text-canvas-text-contrast rounded"
          >
            ✕
          </button>
        </div>

        {/* Share text */}
        <p className="mb-2">Share this room URL:</p>

        {/* URL box */}
        <div className="flex items-center justify-between bg-canvas-bg-subtle rounded p-2 text-secondary-solid ">
          <span
            className="flex-1 mr-1 overflow-hidden text-ellipsis whitespace-nowrap text-canvas-text"
          >
            {shortenedUrl}
          </span>
          <button
            onClick={handleCopyAndClose}
            aria-label='ContentCopyIcon'
            aria-labelledby="ContentCopyIcon"
            className="p-1 text-secondary-solid hover:text-secondary-solid-hover rounded"
          >
            <Copy className="w-4 h-4 font-secondary-bg-active" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareRoomDialog;
