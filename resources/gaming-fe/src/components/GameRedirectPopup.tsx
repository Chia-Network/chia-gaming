// components/GameRedirectPopup.tsx
import React from "react";
import { Button } from "./button";
import { CrossIcon, X } from "lucide-react";

interface GameRedirectPopupProps {
    open: boolean;
    gameName?: string;
    message?: string;
    onAccept: () => void;
    onCancel?: () => void;
}

const GameRedirectPopup = ({
    open,
    gameName = "",
    message = "You have been invited to join this game.",
    onAccept,
    onCancel,
}: GameRedirectPopupProps) => {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas-bg-subtle">
            <div
                className="
          w-11/12 max-w-sm 
          bg-canvas-bg text-canvas-text
          rounded-xl shadow-lg
          border border-canvas-border
        "
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-canvas-border">
                    <h2 className="text-lg font-semibold">
                        {gameName ? `Join ${gameName}?` : "You're Invited!"}
                    </h2>

                    <Button
                        variant={'ghost'}
                        iconOnly
                        leadingIcon={<X />}
                        onClick={onCancel}
                    />
                </div>

                {/* Body */}
                <div className="p-4">
                    <p className="text-sm mb-4">{message}</p>

                    {/* Buttons */}
                    <div className="flex justify-end gap-3">
                        <Button
                            variant={"destructive"}
                            color={'outline'}
                            onClick={onCancel}
                        >
                            Cancel
                        </Button>

                        <Button
                            variant={"solid"}
                            color={'secondary'}
                            onClick={onAccept}
                        >
                            Accept & Join
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};


export default GameRedirectPopup;
